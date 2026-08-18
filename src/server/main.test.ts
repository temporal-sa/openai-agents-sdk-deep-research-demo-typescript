import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { Client } from "@temporalio/client";

import type {
  InteractiveResearchResult,
  ResearchInteraction,
} from "../shared/types.js";
import { createApp } from "./main.js";

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
): Promise<void> {
  const client = fakeClient();
  const app = createApp({
    authMode,
    getTemporalClient: async () => client,
    projectRoot: process.cwd(),
    temporal,
  });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const value = app.listen(0, "127.0.0.1", () => resolve(value));
  });
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
    const denied = await fetch(`${baseUrl}/api/status/test-workflow`);
    assert.equal(denied.status, 401);

    const allowed = await fetch(`${baseUrl}/api/status/test-workflow`, {
      headers: { "X-Temporal-Auth-Email": "researcher@temporal.io" },
    });
    assert.equal(allowed.status, 200);
  });
});
