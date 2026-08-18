import {
  CancellationScope,
  condition,
  defineQuery,
  defineSignal,
  defineUpdate,
  isCancellation,
  log,
  proxyActivities,
  setHandler,
} from "@temporalio/workflow";

import type * as activities from "../activities/index.js";
import {
  currentQuestion,
  enrichQuery,
  interactionFromState,
  validateClarificationResponses,
  type ResearchState,
} from "../shared/research-models.js";
import type {
  ClarificationInput,
  InteractiveResearchResult,
  ResearchFailureStage,
  ResearchInteraction,
  ReportData,
  SingleClarificationInput,
  UserQueryInput,
  WebSearchResult,
} from "../shared/types.js";

const researchActivities = proxyActivities<typeof activities>({
  startToCloseTimeout: "5 minutes",
  scheduleToCloseTimeout: "10 minutes",
  retry: {
    initialInterval: "1 second",
    maximumInterval: "5 seconds",
    backoffCoefficient: 2,
    maximumAttempts: 5,
  },
});

const clarificationActivities = proxyActivities<typeof activities>({
  startToCloseTimeout: "30 seconds",
  retry: {
    initialInterval: "1 second",
    maximumInterval: "5 seconds",
    backoffCoefficient: 2,
    maximumAttempts: 5,
  },
});

const imageActivities = proxyActivities<typeof activities>({
  startToCloseTimeout: "10 minutes",
  scheduleToCloseTimeout: "15 minutes",
  retry: {
    initialInterval: "2 seconds",
    maximumInterval: "15 seconds",
    backoffCoefficient: 2,
    maximumAttempts: 3,
  },
});

const documentActivities = proxyActivities<typeof activities>({
  startToCloseTimeout: "1 minute",
  scheduleToCloseTimeout: "3 minutes",
  retry: {
    initialInterval: "1 second",
    maximumInterval: "5 seconds",
    backoffCoefficient: 2,
    maximumAttempts: 3,
  },
});

export const getStatusQuery = defineQuery<ResearchInteraction>("getStatus");
export const startResearchUpdate = defineUpdate<
  ResearchInteraction,
  [UserQueryInput]
>("startResearch");
export const provideSingleClarificationUpdate = defineUpdate<
  ResearchInteraction,
  [SingleClarificationInput]
>("provideSingleClarification");
export const provideClarificationsUpdate = defineUpdate<
  ResearchInteraction,
  [ClarificationInput]
>("provideClarifications");
export const endWorkflowSignal = defineSignal("endWorkflow");

function errorMessage(error: unknown): string {
  let current: unknown = error;
  let message = error instanceof Error ? error.message : String(error);
  const genericMessages = new Set([
    "Activity task failed",
    "Workflow Update failed",
    "Workflow execution failed",
  ]);
  for (let depth = 0; depth < 8; depth += 1) {
    if (!(current instanceof Error)) break;
    if (current.message && !genericMessages.has(current.message)) {
      message = current.message;
    }
    current = current.cause;
  }
  return message;
}

function terminalResult(
  status: "failed" | "cancelled",
  message: string,
): InteractiveResearchResult {
  return {
    status,
    error_message: status === "failed" ? message : null,
    short_summary: message,
    markdown_report: `# ${status === "failed" ? "Research failed" : "Research cancelled"}\n\n${message}`,
    follow_up_questions: [],
    image_file_path: null,
    pdf_file_path: null,
  };
}

function failState(
  state: ResearchState,
  stage: Exclude<ResearchFailureStage, null>,
  error: unknown,
): InteractiveResearchResult {
  const message = errorMessage(error);
  state.status = "failed";
  state.failureStage = stage;
  state.errorMessage = message;
  return terminalResult("failed", message);
}

async function runResearchPipeline(
  query: string,
): Promise<InteractiveResearchResult> {
  const instructions =
    await researchActivities.createResearchInstructions(query);
  log.info("Starting image generation in parallel with research");
  const imagePromise = imageActivities
    .generateResearchImage(instructions)
    .catch((error: unknown) => {
      if (isCancellation(error)) throw error;
      log.warn("Image activity failed; continuing without an image", { error });
      return null;
    });

  const plan = await researchActivities.planSearches(instructions);
  if (plan.searches.length === 0) {
    throw new Error("The planner did not return any searches");
  }

  const searchResults = (
    await Promise.all(
      plan.searches.map((item) =>
        researchActivities.performSearch(item).catch((error: unknown) => {
          if (isCancellation(error)) throw error;
          log.warn("Search activity failed; continuing with other searches", {
            query: item.query,
            error,
          });
          return null;
        }),
      ),
    )
  ).filter((result): result is WebSearchResult => result !== null);

  if (searchResults.length === 0) {
    throw new Error("All planned web searches failed");
  }

  const report: ReportData = await researchActivities.writeReport({
    query: instructions,
    searchResults,
  });

  const image = await imagePromise;
  const pdf = await documentActivities
    .generatePdf({
      markdown_content: report.markdown_report,
      title: "Research Report",
      image_file_path: image?.image_file_path ?? null,
    })
    .catch((error: unknown) => {
      if (isCancellation(error)) throw error;
      log.warn("PDF activity failed; continuing with Markdown only", { error });
      return null;
    });

  return {
    ...report,
    status: "completed",
    error_message: null,
    image_file_path: image?.image_file_path ?? null,
    pdf_file_path: pdf?.success ? pdf.pdf_file_path : null,
  };
}

export async function interactiveResearchWorkflow(
  initialQuery?: string,
  useClarifications = true,
): Promise<InteractiveResearchResult> {
  const state: ResearchState = {
    originalQuery: null,
    clarificationQuestions: [],
    clarificationResponses: {},
    currentQuestionIndex: 0,
    status: "pending",
    errorMessage: null,
    failureStage: null,
  };
  let researchInitialized = false;
  let activeResearchScope: CancellationScope | null = null;
  const isCancelled = (): boolean => state.status === "cancelled";

  const executeResearch = async (
    query: string,
  ): Promise<InteractiveResearchResult> => {
    const scope = new CancellationScope();
    activeResearchScope = scope;
    try {
      return await scope.run(() => runResearchPipeline(query));
    } finally {
      activeResearchScope = null;
    }
  };

  setHandler(getStatusQuery, () => interactionFromState(state));
  setHandler(endWorkflowSignal, () => {
    state.status = "cancelled";
    state.errorMessage = null;
    state.failureStage = null;
    activeResearchScope?.cancel();
  });

  setHandler(
    startResearchUpdate,
    async (input) => {
      state.originalQuery = input.query.trim();
      state.status = "initializing";
      state.errorMessage = null;
      state.failureStage = null;
      try {
        const clarification = await researchActivities.determineClarifications(
          state.originalQuery,
        );
        state.clarificationQuestions = clarification.questions ?? [];
        if (!isCancelled()) {
          state.status =
            state.clarificationQuestions.length > 0
              ? "awaiting_clarifications"
              : "researching";
        }
      } catch (error) {
        if (!isCancelled()) {
          failState(state, "initialization", error);
        }
      }
      researchInitialized = true;
      return interactionFromState(state);
    },
    {
      validator: (input) => {
        if (!input.query.trim()) throw new Error("Query cannot be empty");
        if (state.originalQuery)
          throw new Error("Research has already started");
      },
    },
  );

  setHandler(
    provideSingleClarificationUpdate,
    async (input) => {
      try {
        const processed = await clarificationActivities.processClarification({
          answer: input.answer.trim(),
          current_question_index: state.currentQuestionIndex,
          current_question: currentQuestion(state),
          total_questions: state.clarificationQuestions.length,
        });
        state.clarificationResponses[processed.question_key] = processed.answer;
        state.currentQuestionIndex = processed.new_index;
        state.status = currentQuestion(state)
          ? "collecting_answers"
          : "researching";
        return interactionFromState(state);
      } catch (error) {
        state.errorMessage = errorMessage(error);
        state.failureStage = "clarification";
        throw error;
      }
    },
    {
      validator: (input) => {
        if (!input.answer.trim()) throw new Error("Answer cannot be empty");
        if (!state.originalQuery)
          throw new Error("No active research interaction");
        if (!currentQuestion(state))
          throw new Error("Not collecting clarifications");
        if (input.question_index !== state.currentQuestionIndex)
          throw new Error("Clarification question index is stale");
      },
    },
  );

  setHandler(
    provideClarificationsUpdate,
    (input) => {
      state.clarificationResponses = Object.fromEntries(
        Object.entries(input.responses).map(([key, answer]) => [
          key,
          answer.trim(),
        ]),
      );
      state.currentQuestionIndex = state.clarificationQuestions.length;
      state.status = "researching";
      return interactionFromState(state);
    },
    {
      validator: (input) => {
        if (!state.originalQuery)
          throw new Error("No active research interaction");
        if (state.clarificationQuestions.length === 0)
          throw new Error("Not awaiting clarifications");
        validateClarificationResponses(
          state.clarificationQuestions,
          input.responses,
        );
      },
    },
  );

  if (initialQuery && !useClarifications) {
    state.originalQuery = initialQuery.trim();
    state.status = "researching";
    try {
      const result = await executeResearch(state.originalQuery);
      if (isCancelled()) {
        return terminalResult("cancelled", "Research cancelled by user");
      }
      state.status = "completed";
      return result;
    } catch (error) {
      if (isCancelled() || isCancellation(error)) {
        state.status = "cancelled";
        return terminalResult("cancelled", "Research cancelled by user");
      }
      return failState(state, "research", error);
    }
  }

  await condition(
    () => researchInitialized || ["failed", "cancelled"].includes(state.status),
  );
  if (state.status === "failed") {
    return terminalResult("failed", state.errorMessage ?? "Research failed");
  }
  if (isCancelled()) {
    return terminalResult("cancelled", "Research cancelled by user");
  }

  if (state.clarificationQuestions.length > 0) {
    const answered = await condition(
      () =>
        isCancelled() ||
        Object.keys(state.clarificationResponses).length >=
          state.clarificationQuestions.length,
      "30 minutes",
    );
    if (!answered) {
      return failState(
        state,
        "clarification",
        new Error("Clarification session timed out after 30 minutes"),
      );
    }
    if (isCancelled()) {
      return terminalResult("cancelled", "Research cancelled by user");
    }
  }

  if (!state.originalQuery) {
    return failState(
      state,
      "initialization",
      new Error("Research failed to initialize"),
    );
  }

  const query =
    state.clarificationQuestions.length > 0
      ? enrichQuery(
          state.originalQuery,
          state.clarificationQuestions,
          state.clarificationResponses,
        )
      : state.originalQuery;

  state.status = "researching";
  try {
    const result = await executeResearch(query);
    if (isCancelled()) {
      return terminalResult("cancelled", "Research cancelled by user");
    }
    state.status = "completed";
    return result;
  } catch (error) {
    if (isCancelled() || isCancellation(error)) {
      state.status = "cancelled";
      return terminalResult("cancelled", "Research cancelled by user");
    }
    return failState(state, "research", error);
  }
}
