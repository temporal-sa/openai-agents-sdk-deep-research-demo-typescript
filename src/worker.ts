import "dotenv/config";

import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { NativeConnection, Worker } from "@temporalio/worker";

import * as activities from "./activities/index.js";
import { temporalConfig, type TemporalConfig } from "./config.js";

export interface ResearchWorkerRuntime {
  run: () => Promise<void>;
  shutdown: () => Promise<void>;
  worker: Worker;
}

export interface CreateResearchWorkerOptions {
  temporal?: TemporalConfig;
  workflowsPath?: string;
}

function defaultWorkflowsPath(): string {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  return fileURLToPath(
    new URL(
      `./workflows/interactive-research-workflow.${extension}`,
      import.meta.url,
    ),
  );
}

export async function createResearchWorker(
  options: CreateResearchWorkerOptions = {},
): Promise<ResearchWorkerRuntime> {
  const config = options.temporal ?? temporalConfig();
  console.log(
    `Connecting worker to Temporal at ${config.address} in namespace ${config.namespace}`,
  );

  const connection = await NativeConnection.connect({
    address: config.address,
    tls: config.tls,
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
  });

  let worker: Worker;
  try {
    worker = await Worker.create({
      connection,
      namespace: config.namespace,
      taskQueue: config.taskQueue,
      workflowsPath: options.workflowsPath ?? defaultWorkflowsPath(),
      activities,
    });
  } catch (error) {
    await connection.close();
    throw error;
  }

  let runPromise: Promise<void> | undefined;
  let connectionClosed = false;
  const closeConnection = async (): Promise<void> => {
    if (connectionClosed) return;
    connectionClosed = true;
    await connection.close();
  };

  const run = (): Promise<void> => {
    runPromise ??= worker.run().finally(closeConnection);
    return runPromise;
  };
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      if (!runPromise) {
        await closeConnection();
        return;
      }
      worker.shutdown();
      await runPromise;
    })();
    return shutdownPromise;
  };

  console.log(`Worker configured for task queue ${config.taskQueue}`);
  return { run, shutdown, worker };
}

async function runStandaloneWorker(): Promise<void> {
  const runtime = await createResearchWorker();
  const shutdown = (): void => {
    void runtime.shutdown().catch((error: unknown) => console.error(error));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    await runtime.run();
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
    await runtime.shutdown();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  runStandaloneWorker().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
