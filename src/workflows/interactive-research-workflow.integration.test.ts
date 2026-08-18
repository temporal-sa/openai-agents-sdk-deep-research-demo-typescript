import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ApplicationFailure } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";

import type * as activityTypes from "../activities/index.js";
import {
  endWorkflowSignal,
  getStatusQuery,
  interactiveResearchWorkflow,
  provideClarificationsUpdate,
  startResearchUpdate,
} from "./interactive-research-workflow.js";

type Activities = typeof activityTypes;

test("interactive workflow reaches successful and terminal failure states", async (t) => {
  const configuredCli = process.env.TEMPORAL_TEST_SERVER_PATH?.trim();
  const environment = await TestWorkflowEnvironment.createLocal({
    ...(configuredCli
      ? {
          server: {
            executable: { type: "existing-path" as const, path: configuredCli },
          },
        }
      : {}),
  });
  t.after(() => environment.teardown());

  const behavior: {
    initializationFails: boolean;
    clarificationQuestions: string[];
  } = { initializationFails: false, clarificationQuestions: [] };

  const activities: Activities = {
    async determineClarifications() {
      if (behavior.initializationFails) {
        throw ApplicationFailure.nonRetryable(
          "OpenAI authentication failed",
          "TestFailure",
        );
      }
      return {
        needs_clarifications: behavior.clarificationQuestions.length > 0,
        questions: behavior.clarificationQuestions,
      };
    },
    async createResearchInstructions(query) {
      return query;
    },
    async planSearches() {
      return { searches: [{ query: "source query", reason: "evidence" }] };
    },
    async performSearch(item) {
      return {
        query: item.query,
        summary: "Verified evidence",
        sources: [{ title: "Primary source", url: "https://example.com" }],
      };
    },
    async writeReport() {
      return {
        short_summary: "A concise summary.",
        markdown_report:
          "# Report\n\nEvidence ([source](https://example.com)).",
        follow_up_questions: ["What should be researched next?"],
      };
    },
    async processClarification(input) {
      return {
        question_key: `question_${input.current_question_index}`,
        answer: input.answer,
        new_index: input.current_question_index + 1,
      };
    },
    async generateImage() {
      return {
        image_file_path: "artifacts/images/test.png",
        mime_type: "image/png",
        success: true,
        error_message: null,
      };
    },
    async generateResearchImage() {
      return {
        success: true,
        image_description: "Test image",
        image_file_path: "artifacts/images/test.png",
        notes: "Fixture",
        error_message: null,
      };
    },
    async generatePdf() {
      return {
        pdf_file_path: "artifacts/reports/test.pdf",
        success: true,
        error_message: null,
      };
    },
  };

  const taskQueue = `research-test-${randomUUID()}`;
  const worker = await Worker.create({
    connection: environment.nativeConnection,
    taskQueue,
    workflowsPath: fileURLToPath(
      new URL("./interactive-research-workflow.js", import.meta.url),
    ),
    activities,
  });

  await worker.runUntil(async () => {
    await t.test("completes a sourced report", async () => {
      behavior.initializationFails = false;
      behavior.clarificationQuestions = [];
      const handle = await environment.client.workflow.start(
        interactiveResearchWorkflow,
        { taskQueue, workflowId: `success-${randomUUID()}` },
      );
      const interaction = await handle.executeUpdate(startResearchUpdate, {
        args: [{ query: "Research a focused topic" }],
      });
      assert.equal(interaction.status, "researching");
      const result = await handle.result();
      assert.equal(result.status, "completed");
      assert.match(result.markdown_report, /example\.com/);
      assert.equal((await handle.query(getStatusQuery)).status, "completed");
    });

    await t.test(
      "reports initialization failure instead of hanging",
      async () => {
        behavior.initializationFails = true;
        behavior.clarificationQuestions = [];
        const handle = await environment.client.workflow.start(
          interactiveResearchWorkflow,
          { taskQueue, workflowId: `failed-${randomUUID()}` },
        );
        const interaction = await handle.executeUpdate(startResearchUpdate, {
          args: [{ query: "Research with a broken key" }],
        });
        assert.equal(interaction.status, "failed");
        assert.equal(interaction.failure_stage, "initialization");
        const result = await handle.result();
        assert.equal(result.status, "failed");
        assert.match(result.error_message ?? "", /authentication failed/);
      },
    );

    await t.test("rejects invalid answers and can be cancelled", async () => {
      behavior.initializationFails = false;
      behavior.clarificationQuestions = ["Which scope?"];
      const handle = await environment.client.workflow.start(
        interactiveResearchWorkflow,
        { taskQueue, workflowId: `cancelled-${randomUUID()}` },
      );
      const interaction = await handle.executeUpdate(startResearchUpdate, {
        args: [{ query: "Research an ambiguous topic" }],
      });
      assert.equal(interaction.status, "awaiting_clarifications");
      await assert.rejects(
        handle.executeUpdate(provideClarificationsUpdate, {
          args: [{ responses: { question_0: " " } }],
        }),
      );
      assert.equal(
        (await handle.query(getStatusQuery)).status,
        "awaiting_clarifications",
      );
      await handle.signal(endWorkflowSignal);
      const result = await handle.result();
      assert.equal(result.status, "cancelled");
    });
  });
});
