import "dotenv/config";

import cors from "cors";
import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { rateLimit } from "express-rate-limit";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import type { Server } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { WorkflowUpdateStage, type Client } from "@temporalio/client";

import { artifactRoot } from "../artifacts.js";
import {
  temporalConfig,
  temporalUiBaseUrl,
  type TemporalConfig,
} from "../config.js";
import type { ResearchInteraction } from "../shared/types.js";
import { createTemporalClient } from "../temporal-client.js";
import {
  endWorkflowSignal,
  getStatusQuery,
  interactiveResearchWorkflow,
  provideSingleClarificationUpdate,
  startResearchUpdate,
} from "../workflows/interactive-research-workflow.js";

export type AuthMode = "disabled" | "temporal-ingress";

interface RateLimitPolicy {
  limit: number;
  windowMs: number;
}

interface AppRateLimits {
  pageViews?: Partial<RateLimitPolicy>;
  startResearch?: Partial<RateLimitPolicy>;
}

export interface CreateAppOptions {
  authMode?: AuthMode;
  artifactsPath?: string;
  frontendOrigins?: readonly string[];
  getTemporalClient?: () => Promise<Client>;
  projectRoot?: string;
  rateLimits?: AppRateLimits;
  temporal?: TemporalConfig;
}

export interface StartServerOptions extends CreateAppOptions {
  closeTemporalClient?: () => Promise<void>;
  host?: string;
  port?: number;
}

export interface RunningServer {
  app: express.Express;
  close: () => Promise<void>;
  closed: Promise<void>;
  server: Server;
}

interface ClientProvider {
  close: () => Promise<void>;
  get: () => Promise<Client>;
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

const DEFAULT_PAGE_VIEW_RATE_LIMIT: RateLimitPolicy = {
  limit: 120,
  windowMs: 60_000,
};

const DEFAULT_START_RESEARCH_RATE_LIMIT: RateLimitPolicy = {
  limit: 5,
  windowMs: 60 * 60_000,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function configuredFrontendOrigins(
  configured: readonly string[],
): ReadonlySet<string> {
  const origins = new Set<string>();

  for (const candidate of configured) {
    const origin = candidate.trim();
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(
        `FRONTEND_ORIGINS contains an invalid origin: ${candidate}`,
      );
    }
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.origin !== origin
    ) {
      throw new Error(
        `FRONTEND_ORIGINS entries must be exact http(s) origins without paths: ${candidate}`,
      );
    }
    origins.add(origin);
  }

  return origins;
}

export function configuredAuthMode(
  environment: NodeJS.ProcessEnv = process.env,
): AuthMode {
  const configured = environment.AUTH_MODE?.trim().toLowerCase();
  if (!configured) {
    return environment.NODE_ENV === "production"
      ? "temporal-ingress"
      : "disabled";
  }
  if (configured === "disabled" || configured === "temporal-ingress") {
    return configured;
  }
  throw new Error("AUTH_MODE must be either 'disabled' or 'temporal-ingress'");
}

function createClientProvider(
  factory: () => Promise<Client> = createTemporalClient,
): ClientProvider {
  let clientPromise: Promise<Client> | undefined;

  return {
    async get() {
      clientPromise ??= factory().catch((error: unknown) => {
        clientPromise = undefined;
        throw error;
      });
      return clientPromise;
    },
    async close() {
      if (!clientPromise) return;
      const pending = clientPromise;
      clientPromise = undefined;
      const client = await pending.catch(() => undefined);
      await client?.connection.close();
    },
  };
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, `${field} must be a non-empty string`);
  }
  return value.trim();
}

function requireWorkflowId(value: string | undefined): string {
  const workflowId = requireText(value, "workflowId");
  if (workflowId.length > 255 || !/^[A-Za-z0-9._:-]+$/.test(workflowId)) {
    throw new HttpError(400, "workflowId contains invalid characters");
  }
  return workflowId;
}

function ingressAuth(authMode: AuthMode): RequestHandler {
  return (request, response, next): void => {
    if (authMode === "disabled") {
      response.locals.authEmail = "local@disabled.invalid";
      next();
      return;
    }

    const email = request.get("X-Temporal-Auth-Email")?.trim().toLowerCase();
    if (!email || !/^[^@\s]+@[^@\s]+$/.test(email)) {
      response.status(401).json({
        detail:
          "Missing or malformed trusted X-Temporal-Auth-Email ingress header",
      });
      return;
    }

    const allowedDomain = process.env.AUTH_ALLOWED_DOMAIN?.trim().toLowerCase();
    if (allowedDomain && !email.endsWith(`@${allowedDomain}`)) {
      response
        .status(403)
        .json({ detail: `Access restricted to @${allowedDomain} accounts` });
      return;
    }

    response.locals.authEmail = email;
    next();
  };
}

function authenticatedEmailRateLimitKey(
  _request: Request,
  response: Response,
): string {
  const email: unknown = response.locals.authEmail;
  if (typeof email !== "string" || !email) {
    throw new Error("Authenticated email missing before rate limiting");
  }
  return email;
}

function serializeStatus(
  workflowId: string,
  status: ResearchInteraction,
): Record<string, unknown> {
  return {
    workflow_id: workflowId,
    ...status,
    total_questions: status.clarification_questions.length,
    questions_remaining: Math.max(
      0,
      status.clarification_questions.length - status.current_question_index,
    ),
  };
}

function artifactUrl(value: string | null): string | null {
  if (!value) return null;
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!/^artifacts\/(images|reports)\/[^/]+$/.test(normalized)) {
    throw new Error(`Workflow returned an invalid artifact path: ${value}`);
  }
  return `/${normalized}`;
}

export function createApp(options: CreateAppOptions = {}): express.Express {
  const app = express();
  const config = options.temporal ?? temporalConfig();
  const mode = options.authMode ?? configuredAuthMode();
  const projectRoot = path.resolve(
    options.projectRoot ?? process.env.PROJECT_ROOT ?? process.cwd(),
  );
  const uiRoot = path.join(projectRoot, "ui");
  const artifactsPath = path.resolve(options.artifactsPath ?? artifactRoot());
  const fallbackProvider = options.getTemporalClient
    ? undefined
    : createClientProvider();
  const getTemporalClient =
    options.getTemporalClient ?? (() => fallbackProvider!.get());
  const authenticate = ingressAuth(mode);
  const allowedFrontendOrigins = configuredFrontendOrigins(
    options.frontendOrigins ??
      (process.env.FRONTEND_ORIGINS ?? "")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
  );
  const pageViewRateLimit = {
    ...DEFAULT_PAGE_VIEW_RATE_LIMIT,
    ...options.rateLimits?.pageViews,
  };
  const startResearchRateLimit = {
    ...DEFAULT_START_RESEARCH_RATE_LIMIT,
    ...options.rateLimits?.startResearch,
  };

  app.use(
    cors({
      origin(origin, callback) {
        callback(null, !origin || allowedFrontendOrigins.has(origin));
      },
    }),
  );
  app.use(express.json({ limit: "1mb" }));

  const limitPageViews = rateLimit({
    ...pageViewRateLimit,
    keyGenerator: authenticatedEmailRateLimitKey,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });

  app.get("/", authenticate, limitPageViews, (_request, response) => {
    response.sendFile(path.join(uiRoot, "index.html"));
  });
  app.get("/success", authenticate, limitPageViews, (_request, response) => {
    response.sendFile(path.join(uiRoot, "success.html"));
  });
  app.use("/static", express.static(uiRoot));

  app.get("/api/health", (_request, response) => {
    response.json({
      status: "healthy",
      auth_mode: mode,
      temporal_address: config.address,
      temporal_namespace: config.namespace,
      task_queue: config.taskQueue,
    });
  });

  app.get("/api/ready", async (_request, response) => {
    try {
      const client = await getTemporalClient();
      await client.withDeadline(Date.now() + 3_000, () =>
        client.workflowService.getSystemInfo({}),
      );
      response.json({ status: "ready", temporal: "connected" });
    } catch (error) {
      response.status(503).json({
        status: "not_ready",
        temporal: "unavailable",
        detail: errorMessage(error),
      });
    }
  });

  app.use(
    "/artifacts",
    authenticate,
    express.static(artifactsPath, {
      dotfiles: "deny",
      fallthrough: false,
      index: false,
    }),
  );

  const api = express.Router();
  api.use(authenticate);

  const limitResearchStarts = rateLimit({
    ...startResearchRateLimit,
    keyGenerator: authenticatedEmailRateLimitKey,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_request, response) => {
      response.status(429).json({
        detail: "Too many research requests. Please try again later.",
      });
    },
  });

  api.post(
    "/start-research",
    limitResearchStarts,
    async (request, response) => {
      const query = requireText(request.body?.query, "query");
      const client = await getTemporalClient();
      const workflowId = `interactive-research-${randomUUID().slice(0, 8)}`;
      const handle = await client.workflow.start(interactiveResearchWorkflow, {
        workflowId,
        taskQueue: config.taskQueue,
        args: [],
      });

      try {
        await handle.startUpdate(startResearchUpdate, {
          args: [{ query }],
          waitForStage: WorkflowUpdateStage.ACCEPTED,
        });
        const status = await handle.query(getStatusQuery);
        response.status(201).json({
          ...serializeStatus(workflowId, status),
          temporal_ui_url: `${temporalUiBaseUrl(config)}/${encodeURIComponent(workflowId)}`,
        });
      } catch (error) {
        await handle.signal(endWorkflowSignal).catch(() => undefined);
        response.status(502).json({
          workflow_id: workflowId,
          status: "failed",
          detail: `Research initialization failed: ${errorMessage(error)}`,
          temporal_ui_url: `${temporalUiBaseUrl(config)}/${encodeURIComponent(workflowId)}`,
        });
      }
    },
  );

  api.get("/status/:workflowId", async (request, response) => {
    const workflowId = requireWorkflowId(request.params.workflowId);
    const client = await getTemporalClient();
    const handle =
      client.workflow.getHandle<typeof interactiveResearchWorkflow>(workflowId);
    const status = await handle.query(getStatusQuery);
    response.json(serializeStatus(workflowId, status));
  });

  api.post("/answer/:workflowId/:questionIndex", async (request, response) => {
    const workflowId = requireWorkflowId(request.params.workflowId);
    const answer = requireText(request.body?.answer, "answer");
    const questionIndex = Number.parseInt(
      request.params.questionIndex ?? "",
      10,
    );
    if (!Number.isSafeInteger(questionIndex) || questionIndex < 0) {
      throw new HttpError(400, "questionIndex must be a non-negative integer");
    }

    const client = await getTemporalClient();
    const handle =
      client.workflow.getHandle<typeof interactiveResearchWorkflow>(workflowId);
    const status = await handle.executeUpdate(
      provideSingleClarificationUpdate,
      {
        args: [{ question_index: questionIndex, answer }],
      },
    );
    response.json(serializeStatus(workflowId, status));
  });

  api.post("/cancel/:workflowId", async (request, response) => {
    const workflowId = requireWorkflowId(request.params.workflowId);
    const client = await getTemporalClient();
    const handle =
      client.workflow.getHandle<typeof interactiveResearchWorkflow>(workflowId);
    await handle.signal(endWorkflowSignal);
    const status = await handle.query(getStatusQuery);
    response.json(serializeStatus(workflowId, status));
  });

  api.get("/result/:workflowId", async (request, response) => {
    const workflowId = requireWorkflowId(request.params.workflowId);
    const client = await getTemporalClient();
    const handle =
      client.workflow.getHandle<typeof interactiveResearchWorkflow>(workflowId);
    const status = await handle.query(getStatusQuery);
    if (
      status.status !== "completed" &&
      status.status !== "failed" &&
      status.status !== "cancelled"
    ) {
      throw new HttpError(409, "Research is not in a terminal state yet");
    }

    const result = await handle.result();
    response.json({
      workflow_id: workflowId,
      ...result,
      image_file_path: artifactUrl(result.image_file_path),
      pdf_file_path: artifactUrl(result.pdf_file_path),
    });
  });

  api.use((_request, response) => {
    response.status(404).json({ detail: "API route not found" });
  });
  app.use("/api", api);

  app.use(
    (
      error: unknown,
      _request: Request,
      response: Response,
      _next: NextFunction,
    ) => {
      const statusCode =
        error instanceof HttpError
          ? error.statusCode
          : typeof error === "object" &&
              error !== null &&
              "statusCode" in error &&
              typeof error.statusCode === "number"
            ? error.statusCode
            : 500;
      const message = errorMessage(error);
      console.error(error);
      response.status(statusCode).json({ detail: message });
    },
  );

  return app;
}

export async function startServer(
  options: StartServerOptions = {},
): Promise<RunningServer> {
  const provider = options.getTemporalClient
    ? {
        get: options.getTemporalClient,
        close: options.closeTemporalClient ?? (async () => undefined),
      }
    : createClientProvider();
  const artifactsPath = path.resolve(options.artifactsPath ?? artifactRoot());
  await mkdir(artifactsPath, { recursive: true });

  const app = createApp({
    ...(options.authMode ? { authMode: options.authMode } : {}),
    artifactsPath,
    ...(options.frontendOrigins
      ? { frontendOrigins: options.frontendOrigins }
      : {}),
    getTemporalClient: provider.get,
    ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
    ...(options.rateLimits ? { rateLimits: options.rateLimits } : {}),
    ...(options.temporal ? { temporal: options.temporal } : {}),
  });
  const port = options.port ?? Number.parseInt(process.env.PORT ?? "8234", 10);
  const host = options.host ?? process.env.HOST?.trim() ?? "0.0.0.0";
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  const server = await new Promise<Server>((resolve, reject) => {
    const candidate = app.listen(port, host);
    candidate.once("error", reject);
    candidate.once("listening", () => {
      candidate.off("error", reject);
      resolve(candidate);
    });
  }).catch(async (error: unknown) => {
    await provider.close();
    throw error;
  });

  console.log(`Research UI listening on http://${host}:${port}`);

  let closePromise: Promise<void> | undefined;
  const closed = new Promise<void>((resolve, reject) => {
    server.once("close", resolve);
    server.once("error", reject);
  });
  const close = (): Promise<void> => {
    closePromise ??= (async () => {
      try {
        if (server.listening) {
          await new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          });
        }
      } finally {
        await provider.close();
      }
    })();
    return closePromise;
  };

  return { app, close, closed, server };
}

async function runStandaloneServer(): Promise<void> {
  const runtime = await startServer();
  const shutdown = (): void => {
    void runtime.close().catch((error: unknown) => console.error(error));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    await runtime.closed;
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    await runtime.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  runStandaloneServer().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
