import { Context } from "@temporalio/activity";
import { run } from "@openai/agents";

import { newClarifyingAgent } from "../agents/clarifying-agent.js";
import { newPlannerAgent } from "../agents/planner-agent.js";
import { newSearchAgent } from "../agents/search-agent.js";
import { newTriageAgent } from "../agents/triage-agent.js";
import { newWriterAgent } from "../agents/writer-agent.js";
import { newInstructionAgent } from "../agents/instruction-agent.js";
import type {
  ClarificationResult,
  ProcessClarificationInput,
  ProcessClarificationResult,
  ReportData,
  WebSearchItem,
  WebSearchPlan,
  WebSearchResult,
} from "../shared/types.js";

function finalOutput<T>(value: T | undefined, activityName: string): T {
  if (value === undefined) {
    throw new Error(`${activityName} did not produce a final output`);
  }
  return value;
}

export async function determineClarifications(
  query: string,
): Promise<ClarificationResult> {
  const triage = await run(newTriageAgent(), query);
  const decision = finalOutput(triage.finalOutput, "Triage agent");

  if (!decision.needs_clarifications) {
    return { needs_clarifications: false };
  }

  const result = await run(newClarifyingAgent(), query);
  const clarifications = finalOutput(
    result.finalOutput,
    "Clarifying questions agent",
  );
  return {
    needs_clarifications: true,
    questions: clarifications.questions,
  };
}

export async function planSearches(query: string): Promise<WebSearchPlan> {
  const result = await run(newPlannerAgent(), `Query: ${query}`);
  return finalOutput(result.finalOutput, "Planner agent");
}

export async function createResearchInstructions(
  query: string,
): Promise<string> {
  const result = await run(newInstructionAgent(), query);
  return finalOutput(result.finalOutput, "Research instruction agent");
}

export async function performSearch(
  item: WebSearchItem,
): Promise<WebSearchResult> {
  const input = `Search term: ${item.query}\nReason for searching: ${item.reason}`;
  const result = await run(newSearchAgent(), input);
  const output = finalOutput(result.finalOutput, "Search agent");
  return {
    query: item.query,
    summary: output.summary,
    sources: output.sources,
  };
}

export async function writeReport(input: {
  query: string;
  searchResults: WebSearchResult[];
}): Promise<ReportData> {
  const prompt = [
    `Original query: ${input.query}`,
    "Structured research results with exact source URLs:",
    JSON.stringify(input.searchResults, null, 2),
  ].join("\n");
  const result = await run(newWriterAgent(), prompt);
  return finalOutput(result.finalOutput, "Writer agent");
}

export async function processClarification(
  input: ProcessClarificationInput,
): Promise<ProcessClarificationResult> {
  Context.current().log.info("Processing clarification answer", {
    question: input.current_question,
    questionNumber: input.current_question_index + 1,
    totalQuestions: input.total_questions,
  });

  // Preserve the demo's retry visualization on the second-to-last answer.
  const isSecondToLast =
    input.current_question_index + 2 === input.total_questions;
  const attempt = Context.current().info.attempt;
  if (isSecondToLast && attempt <= 3) {
    if (attempt > 1) {
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
    throw new Error("Simulated failure -- try again soon :)");
  }

  return {
    question_key: `question_${input.current_question_index}`,
    answer: input.answer,
    new_index: input.current_question_index + 1,
  };
}
