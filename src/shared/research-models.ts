import type {
  ResearchFailureStage,
  ResearchInteraction,
  ResearchStatus,
} from "./types.js";

export interface ResearchState {
  originalQuery: string | null;
  clarificationQuestions: string[];
  clarificationResponses: Record<string, string>;
  currentQuestionIndex: number;
  status: ResearchStatus;
  errorMessage: string | null;
  failureStage: ResearchFailureStage;
}

export function currentQuestion(state: ResearchState): string | null {
  return state.clarificationQuestions[state.currentQuestionIndex] ?? null;
}

export function researchStatus(state: ResearchState): ResearchStatus {
  return state.status;
}

export function interactionFromState(
  state: ResearchState,
): ResearchInteraction {
  return {
    original_query: state.originalQuery,
    clarification_questions: state.clarificationQuestions,
    clarification_responses: state.clarificationResponses,
    current_question_index: state.currentQuestionIndex,
    current_question: currentQuestion(state),
    status: researchStatus(state),
    research_completed: state.status === "completed",
    error_message: state.errorMessage,
    failure_stage: state.failureStage,
  };
}

export function validateClarificationResponses(
  questions: string[],
  responses: Record<string, string>,
): void {
  const expected = new Set(questions.map((_, index) => `question_${index}`));
  const supplied = Object.keys(responses);
  if (supplied.length !== expected.size) {
    throw new Error("A response is required for every clarification question");
  }
  for (const [key, answer] of Object.entries(responses)) {
    if (!expected.has(key))
      throw new Error(`Unexpected clarification key: ${key}`);
    if (!answer.trim())
      throw new Error(`Clarification response ${key} is empty`);
  }
}

export function enrichQuery(
  originalQuery: string,
  questions: string[],
  responses: Record<string, string>,
): string {
  const answers = questions.map((question, index) => {
    const answer = responses[`question_${index}`] ?? "No specific preference";
    return `- ${question}: ${answer}`;
  });

  return [
    `Original query: ${originalQuery}`,
    "",
    "Additional context from clarifications:",
    ...answers,
  ].join("\n");
}
