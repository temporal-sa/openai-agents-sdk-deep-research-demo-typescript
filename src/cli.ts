import "dotenv/config";

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import type { Client, WorkflowHandle } from "@temporalio/client";

import { temporalConfig } from "./config.js";
import type {
  InteractiveResearchResult,
  ResearchInteraction,
} from "./shared/types.js";
import { createTemporalClient } from "./temporal-client.js";
import {
  endWorkflowSignal,
  getStatusQuery,
  interactiveResearchWorkflow,
  provideClarificationsUpdate,
  provideSingleClarificationUpdate,
  startResearchUpdate,
} from "./workflows/interactive-research-workflow.js";

type ResearchHandle = WorkflowHandle<typeof interactiveResearchWorkflow>;

export interface CliArguments {
  cancel: boolean;
  clarifications: string[];
  help: boolean;
  outputPath?: string;
  query: string;
  result: boolean;
  status: boolean;
  workflowId?: string;
}

const usage = `OpenAI Agents + Temporal deep-research demo

Usage:
  npm run cli -- [options] "research query"
  npm run cli -- --status --workflow-id WORKFLOW_ID
  npm run cli -- --result --workflow-id WORKFLOW_ID [--output FILE]
  npm run cli -- --cancel --workflow-id WORKFLOW_ID
  npm run cli -- --clarify question_0=VALUE --workflow-id WORKFLOW_ID

Options:
  --workflow-id ID   Use this exact workflow ID; generated when starting if omitted
  --status           Show current workflow state
  --result           Fetch a terminal workflow result
  --cancel           Request graceful workflow cancellation
  --clarify K=V      Submit all clarification answers (repeatable)
  --output FILE      Markdown output path for completed results
  -h, --help         Show this help
`;

export function parseCliArguments(args: string[]): CliArguments {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      "workflow-id": { type: "string" },
      status: { type: "boolean", default: false },
      result: { type: "boolean", default: false },
      cancel: { type: "boolean", default: false },
      clarify: { type: "string", multiple: true, default: [] },
      output: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  const workflowId = values["workflow-id"]?.trim() || undefined;
  const outputPath = values.output?.trim() || undefined;
  return {
    cancel: values.cancel,
    clarifications: values.clarify,
    help: values.help,
    query: positionals.join(" ").trim(),
    result: values.result,
    status: values.status,
    ...(outputPath ? { outputPath } : {}),
    ...(workflowId ? { workflowId } : {}),
  };
}

function parseClarifications(values: string[]): Record<string, string> {
  return Object.fromEntries(
    values.map((value) => {
      const separator = value.indexOf("=");
      if (separator <= 0 || !value.slice(separator + 1).trim()) {
        throw new Error(`Invalid clarification '${value}'; expected KEY=VALUE`);
      }
      return [
        value.slice(0, separator).trim(),
        value.slice(separator + 1).trim(),
      ];
    }),
  );
}

function requiredWorkflowId(arguments_: CliArguments, command: string): string {
  if (!arguments_.workflowId) {
    throw new Error(`--workflow-id is required with --${command}`);
  }
  return arguments_.workflowId;
}

function getHandle(client: Client, workflowId: string): ResearchHandle {
  return client.workflow.getHandle<typeof interactiveResearchWorkflow>(
    workflowId,
  );
}

function printStatus(workflowId: string, status: ResearchInteraction): void {
  console.log(`Workflow ID: ${workflowId}`);
  console.log(`Status: ${status.status}`);
  if (status.current_question) {
    console.log(
      `Question ${status.current_question_index + 1}/${status.clarification_questions.length}: ${status.current_question}`,
    );
  }
  if (status.failure_stage)
    console.log(`Failure stage: ${status.failure_stage}`);
  if (status.error_message) console.log(`Error: ${status.error_message}`);
}

function defaultOutputPath(workflowId: string): string {
  const safeId = workflowId.replaceAll(/[^A-Za-z0-9._-]/g, "-");
  return path.join("output", `${safeId}.md`);
}

async function saveResult(
  result: InteractiveResearchResult,
  workflowId: string,
  requestedPath?: string,
): Promise<string | undefined> {
  if (result.status !== "completed") return undefined;
  const outputPath = path.resolve(
    requestedPath ?? defaultOutputPath(workflowId),
  );
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, result.markdown_report, "utf8");
  return outputPath;
}

function printResult(
  result: InteractiveResearchResult,
  savedPath?: string,
): void {
  console.log(`Result status: ${result.status}`);
  if (result.error_message) console.log(`Error: ${result.error_message}`);
  console.log(`Summary: ${result.short_summary}`);
  if (savedPath) console.log(`Markdown: ${savedPath}`);
  if (result.pdf_file_path) console.log(`PDF: ${result.pdf_file_path}`);
  if (result.image_file_path) console.log(`Image: ${result.image_file_path}`);
  if (result.follow_up_questions.length > 0) {
    console.log("Follow-up questions:");
    result.follow_up_questions.forEach((question, index) => {
      console.log(`  ${index + 1}. ${question}`);
    });
  }
}

async function runInteractive(
  client: Client,
  query: string,
  workflowId: string,
  requestedOutputPath?: string,
): Promise<number> {
  const config = temporalConfig();
  console.log(`Workflow ID: ${workflowId}`);
  console.log(`Starting interactive research: ${query}`);
  const handle = await client.workflow.start(interactiveResearchWorkflow, {
    workflowId,
    taskQueue: config.taskQueue,
    args: [],
  });

  let status = await handle.executeUpdate(startResearchUpdate, {
    args: [{ query }],
  });
  const reader = createInterface({ input, output });
  try {
    while (true) {
      if (
        (status.status === "awaiting_clarifications" ||
          status.status === "collecting_answers") &&
        status.current_question
      ) {
        console.log(
          `\nQuestion ${status.current_question_index + 1} of ${status.clarification_questions.length}`,
        );
        const answer = (
          await reader.question(`${status.current_question}\nYour answer: `)
        ).trim();
        if (["exit", "quit", "end", "done"].includes(answer.toLowerCase())) {
          await handle.signal(endWorkflowSignal);
          break;
        }
        status = await handle.executeUpdate(provideSingleClarificationUpdate, {
          args: [
            {
              question_index: status.current_question_index,
              answer: answer || "No specific preference",
            },
          ],
        });
        continue;
      }

      if (["completed", "failed", "cancelled"].includes(status.status)) break;
      if (status.status === "researching") {
        console.log(
          "\nResearch in progress. Planning, searching, writing, and generating artifacts…",
        );
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      status = await handle.query(getStatusQuery);
    }
  } finally {
    reader.close();
  }

  const result = await handle.result();
  const savedPath = await saveResult(result, workflowId, requestedOutputPath);
  printResult(result, savedPath);
  return result.status === "failed" ? 1 : 0;
}

export async function runCli(
  args: string[] = process.argv.slice(2),
  clientFactory: () => Promise<Client> = createTemporalClient,
): Promise<number> {
  const arguments_ = parseCliArguments(args);
  if (arguments_.help) {
    console.log(usage);
    return 0;
  }

  const commandCount = [
    arguments_.status,
    arguments_.result,
    arguments_.cancel,
    arguments_.clarifications.length > 0,
  ].filter(Boolean).length;
  if (commandCount > 1) {
    throw new Error(
      "Choose only one of --status, --result, --cancel, or --clarify",
    );
  }

  const client = await clientFactory();
  try {
    if (arguments_.status) {
      const workflowId = requiredWorkflowId(arguments_, "status");
      const status = await getHandle(client, workflowId).query(getStatusQuery);
      printStatus(workflowId, status);
      return status.status === "failed" ? 1 : 0;
    }

    if (arguments_.result) {
      const workflowId = requiredWorkflowId(arguments_, "result");
      const handle = getHandle(client, workflowId);
      const status = await handle.query(getStatusQuery);
      if (!["completed", "failed", "cancelled"].includes(status.status)) {
        printStatus(workflowId, status);
        console.error("Result is not ready");
        return 2;
      }
      const result = await handle.result();
      const savedPath = await saveResult(
        result,
        workflowId,
        arguments_.outputPath,
      );
      printResult(result, savedPath);
      return result.status === "failed" ? 1 : 0;
    }

    if (arguments_.cancel) {
      const workflowId = requiredWorkflowId(arguments_, "cancel");
      const handle = getHandle(client, workflowId);
      await handle.signal(endWorkflowSignal);
      const status = await handle.query(getStatusQuery);
      printStatus(workflowId, status);
      return 0;
    }

    if (arguments_.clarifications.length > 0) {
      const workflowId = requiredWorkflowId(arguments_, "clarify");
      const handle = getHandle(client, workflowId);
      const status = await handle.executeUpdate(provideClarificationsUpdate, {
        args: [{ responses: parseClarifications(arguments_.clarifications) }],
      });
      printStatus(workflowId, status);
      return 0;
    }

    let query = arguments_.query;
    if (!query) {
      const reader = createInterface({ input, output });
      try {
        query = (await reader.question("Enter your research query: ")).trim();
      } finally {
        reader.close();
      }
    }
    if (!query) throw new Error("Query cannot be empty");

    const workflowId =
      arguments_.workflowId ??
      `interactive-research-${randomUUID().slice(0, 8)}`;
    return runInteractive(client, query, workflowId, arguments_.outputPath);
  } finally {
    await client.connection.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  runCli()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
