import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { Client } from "@temporalio/client";

import type {
  InteractiveResearchResult,
  ResearchInteraction,
} from "../shared/types.js";
import { createApp } from "./main.js";

interface TestServerOptions {
  frontendOrigins?: readonly string[];
  rateLimits?: {
    pageViews?: { limit: number; windowMs: number };
    startResearch?: { limit: number; windowMs: number };
  };
}

const temporal = {
  address: "temporal.test:7233",
  namespace: "test",
  tls: false,
  taskQueue: "research-test",
};

function interaction(
  status: ResearchInteraction["status"],
): ResearchInteraction {
  return {
    original_query: "Test query",
    clarification_questions: [],
    clarification_responses: {},
    current_question_index: 0,
    current_question: null,
    status,
    research_completed: status === "completed",
    error_message: null,
    failure_stage: null,
  };
}

function fakeClient(): Client {
  const result: InteractiveResearchResult = {
    status: "completed",
    error_message: null,
    short_summary: "Summary",
    markdown_report: "# Report",
    follow_up_questions: [],
    image_file_path: null,
    pdf_file_path: null,
  };
  let queryCount = 0;
  const handle = {
    startUpdate: async () => ({
      result: async () => interaction("researching"),
    }),
    query: async () =>
      interaction(queryCount++ === 0 ? "researching" : "completed"),
    result: async () => result,
    signal: async () => undefined,
  };
  return {
    workflow: {
      start: async () => handle,
      getHandle: () => handle,
    },
    workflowService: { getSystemInfo: async () => ({}) },
    withDeadline: async (
      _deadline: number,
      operation: () => Promise<unknown>,
    ) => operation(),
  } as unknown as Client;
}

async function withServer(
  authMode: "disabled" | "temporal-ingress",
  callback: (baseUrl: string) => Promise<void>,
  options: TestServerOptions = {},
): Promise<void> {
  const client = fakeClient();
  const app = createApp({
    authMode,
    ...(options.frontendOrigins
      ? { frontendOrigins: options.frontendOrigins }
      : {}),
    getTemporalClient: async () => client,
    projectRoot: process.cwd(),
    ...(options.rateLimits ? { rateLimits: options.rateLimits } : {}),
    temporal,
  });
  const server = await new Promise<ReturnType<typeof app.listen>>(
    (resolve, reject) => {
      const value = app.listen(0, "127.0.0.1");
      value.once("error", reject);
      value.once("listening", () => {
        value.off("error", reject);
        resolve(value);
      });
    },
  );
  try {
    const address = server.address() as AddressInfo;
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
}

test("server health, readiness, start, and result API", async () => {
  await withServer("disabled", async (baseUrl) => {
    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);

    const ready = await fetch(`${baseUrl}/api/ready`);
    assert.equal(ready.status, 200);

    const started = await fetch(`${baseUrl}/api/start-research`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "Test query" }),
    });
    assert.equal(started.status, 201);
    const startBody = (await started.json()) as Record<string, unknown>;
    assert.equal(startBody.status, "researching");
    assert.match(String(startBody.workflow_id), /^interactive-research-/);

    const result = await fetch(
      `${baseUrl}/api/result/${String(startBody.workflow_id)}`,
    );
    assert.equal(result.status, 200);
    assert.equal(
      ((await result.json()) as Record<string, unknown>).status,
      "completed",
    );
  });
});

test("temporal-ingress auth rejects spoofable direct requests", async () => {
  await withServer("temporal-ingress", async (baseUrl) => {
    const deniedPage = await fetch(`${baseUrl}/`);
    assert.equal(deniedPage.status, 401);

    const denied = await fetch(`${baseUrl}/api/status/test-workflow`);
    assert.equal(denied.status, 401);

    const allowedPage = await fetch(`${baseUrl}/`, {
      headers: { "X-Temporal-Auth-Email": "researcher@temporal.io" },
    });
    assert.equal(allowedPage.status, 200);

    const allowed = await fetch(`${baseUrl}/api/status/test-workflow`, {
      headers: { "X-Temporal-Auth-Email": "researcher@temporal.io" },
    });
    assert.equal(allowed.status, 200);
  });
});

test("CORS allows only configured exact origins without breaking same-origin requests", async () => {
  await withServer(
    "disabled",
    async (baseUrl) => {
      const allowed = await fetch(`${baseUrl}/api/health`, {
        headers: { Origin: "https://research.example.com" },
      });
      assert.equal(allowed.status, 200);
      assert.equal(
        allowed.headers.get("access-control-allow-origin"),
        "https://research.example.com",
      );
      assert.equal(
        allowed.headers.get("access-control-allow-credentials"),
        null,
      );

      const denied = await fetch(`${baseUrl}/api/health`, {
        headers: { Origin: "https://research.example.com.evil.test" },
      });
      assert.equal(denied.status, 200);
      assert.equal(denied.headers.get("access-control-allow-origin"), null);

      const deniedPreflight = await fetch(`${baseUrl}/api/start-research`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://research.example.com.evil.test",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      });
      assert.equal(
        deniedPreflight.headers.get("access-control-allow-origin"),
        null,
      );

      const sameOrigin = await fetch(`${baseUrl}/api/health`, {
        headers: { Origin: baseUrl },
      });
      assert.equal(sameOrigin.status, 200);
    },
    { frontendOrigins: ["https://research.example.com"] },
  );

  for (const invalidOrigin of ["*", "https://research.example.com/path"]) {
    assert.throws(
      () =>
        createApp({
          authMode: "disabled",
          frontendOrigins: [invalidOrigin],
          getTemporalClient: async () => fakeClient(),
          projectRoot: process.cwd(),
          temporal,
        }),
      /FRONTEND_ORIGINS/,
    );
  }
});

test("page routes share a small page-view rate limit", async () => {
  await withServer(
    "disabled",
    async (baseUrl) => {
      assert.equal((await fetch(`${baseUrl}/`)).status, 200);
      assert.equal((await fetch(`${baseUrl}/success`)).status, 200);
      assert.equal((await fetch(`${baseUrl}/success`)).status, 429);
    },
    { rateLimits: { pageViews: { limit: 2, windowMs: 60_000 } } },
  );
});

test("research-start rate limit is keyed by authenticated email", async () => {
  await withServer(
    "temporal-ingress",
    async (baseUrl) => {
      const start = (email: string) =>
        fetch(`${baseUrl}/api/start-research`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "X-Temporal-Auth-Email": email,
          },
          body: JSON.stringify({ query: "Test query" }),
        });

      assert.equal((await start("one@temporal.io")).status, 201);

      const blocked = await start("one@temporal.io");
      assert.equal(blocked.status, 429);
      assert.match(blocked.headers.get("content-type") ?? "", /json/);
      assert.ok(blocked.headers.has("retry-after"));
      assert.deepEqual(await blocked.json(), {
        detail: "Too many research requests. Please try again later.",
      });

      assert.equal((await start("two@temporal.io")).status, 201);
      const polling = await fetch(`${baseUrl}/api/status/test-workflow`, {
        headers: { "X-Temporal-Auth-Email": "one@temporal.io" },
      });
      assert.equal(polling.status, 200);
    },
    { rateLimits: { startResearch: { limit: 1, windowMs: 60_000 } } },
  );
});
