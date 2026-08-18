import assert from "node:assert/strict";
import test from "node:test";

import {
  currentQuestion,
  enrichQuery,
  interactionFromState,
  researchStatus,
  validateClarificationResponses,
  type ResearchState,
} from "./research-models.js";

function state(overrides: Partial<ResearchState> = {}): ResearchState {
  return {
    originalQuery: null,
    clarificationQuestions: [],
    clarificationResponses: {},
    currentQuestionIndex: 0,
    status: "pending",
    errorMessage: null,
    failureStage: null,
    ...overrides,
  };
}

test("research status is explicit for every lifecycle phase", () => {
  for (const status of [
    "pending",
    "initializing",
    "awaiting_clarifications",
    "collecting_answers",
    "researching",
    "completed",
    "failed",
    "cancelled",
  ] as const) {
    assert.equal(researchStatus(state({ status })), status);
  }
});

test("current question and interaction serialization use the active index", () => {
  const value = state({
    originalQuery: "query",
    clarificationQuestions: ["One?", "Two?"],
    clarificationResponses: { question_0: "answer" },
    currentQuestionIndex: 1,
    status: "collecting_answers",
  });
  assert.equal(currentQuestion(value), "Two?");
  assert.deepEqual(interactionFromState(value), {
    original_query: "query",
    clarification_questions: ["One?", "Two?"],
    clarification_responses: { question_0: "answer" },
    current_question_index: 1,
    current_question: "Two?",
    status: "collecting_answers",
    research_completed: false,
    error_message: null,
    failure_stage: null,
  });
});

test("failed interaction exposes the terminal error", () => {
  assert.deepEqual(
    interactionFromState(
      state({
        originalQuery: "query",
        status: "failed",
        errorMessage: "Planner unavailable",
        failureStage: "research",
      }),
    ),
    {
      original_query: "query",
      clarification_questions: [],
      clarification_responses: {},
      current_question_index: 0,
      current_question: null,
      status: "failed",
      research_completed: false,
      error_message: "Planner unavailable",
      failure_stage: "research",
    },
  );
});

test("bulk clarification validation requires exact, non-empty answers", () => {
  const questions = ["Budget?", "Month?"];
  assert.doesNotThrow(() =>
    validateClarificationResponses(questions, {
      question_0: "$2,000",
      question_1: "September",
    }),
  );
  assert.throws(
    () => validateClarificationResponses(questions, { question_0: "$2,000" }),
    /every clarification question/,
  );
  assert.throws(
    () =>
      validateClarificationResponses(questions, {
        question_0: "$2,000",
        unexpected: "September",
      }),
    /Unexpected clarification key/,
  );
  assert.throws(
    () =>
      validateClarificationResponses(questions, {
        question_0: "$2,000",
        question_1: "   ",
      }),
    /is empty/,
  );
});

test("enrichQuery preserves ordered questions and supplies a default", () => {
  assert.equal(
    enrichQuery("Find a trip", ["Budget?", "Month?"], {
      question_0: "$2,000",
    }),
    "Original query: Find a trip\n\n" +
      "Additional context from clarifications:\n" +
      "- Budget?: $2,000\n" +
      "- Month?: No specific preference",
  );
});
