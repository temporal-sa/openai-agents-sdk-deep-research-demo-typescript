import "dotenv/config";

import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  startServer,
  type RunningServer,
  type StartServerOptions,
} from "./server/main.js";
import {
  createResearchWorker,
  type CreateResearchWorkerOptions,
  type ResearchWorkerRuntime,
} from "./worker.js";

export interface StartApplicationOptions {
  server?: StartServerOptions;
  worker?: CreateResearchWorkerOptions;
}

export interface ApplicationRuntime {
  server: RunningServer;
  shutdown: () => Promise<void>;
  wait: () => Promise<void>;
  worker: ResearchWorkerRuntime;
}

export async function startApplication(
  options: StartApplicationOptions = {},
): Promise<ApplicationRuntime> {
  const worker = await createResearchWorker(options.worker);
  const workerRun = worker.run();

  let server: RunningServer;
  try {
    server = await startServer(options.server);
  } catch (error) {
    await worker.shutdown().catch(() => undefined);
    throw error;
  }

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= (async () => {
      const results = await Promise.allSettled([
        server.close(),
        worker.shutdown(),
      ]);
      const rejection = results.find(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      );
      if (rejection) throw rejection.reason;
    })();
    return shutdownPromise;
  };

  const wait = async (): Promise<void> => {
    try {
      await Promise.race([workerRun, server.closed]);
    } finally {
      await shutdown();
    }
  };

  return { server, shutdown, wait, worker };
}

async function runApplication(): Promise<void> {
  const runtime = await startApplication();
  const shutdown = (): void => {
    void runtime.shutdown().catch((error: unknown) => console.error(error));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    await runtime.wait();
  } finally {
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  runApplication().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
