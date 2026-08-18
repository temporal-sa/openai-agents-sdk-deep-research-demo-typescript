export type ResearchStatus =
  | "pending"
  | "initializing"
  | "awaiting_clarifications"
  | "collecting_answers"
  | "researching"
  | "completed"
  | "failed"
  | "cancelled";

export interface ResearchStatusResponse {
  workflow_id: string;
  status: ResearchStatus;
  original_query: string | null;
  clarification_questions: string[];
  clarification_responses: Record<string, string>;
  current_question: string | null;
  current_question_index: number;
  total_questions: number;
  research_completed: boolean;
  error_message: string | null;
  failure_stage: "initialization" | "clarification" | "research" | null;
}

export interface StartResearchResponse {
  workflow_id: string;
  status: string;
  temporal_ui_url: string;
  interaction: ResearchStatusResponse;
}

export interface ResearchResultResponse {
  workflow_id: string;
  status: "completed" | "failed" | "cancelled";
  error_message: string | null;
  markdown_report: string;
  short_summary: string;
  follow_up_questions: string[];
  image_file_path: string | null;
  pdf_file_path: string | null;
}

export interface CancelResearchResponse {
  workflow_id: string;
  status: string;
  interaction?: ResearchStatusResponse;
}

interface PollOptions {
  interval?: number;
  retryInterval?: number;
  onError?: (error: Error) => void | Promise<void>;
}

interface JsonObject {
  [key: string]: unknown;
}

declare global {
  interface Window {
    ResearchClient: typeof ResearchClient;
  }
}

const terminalStatuses = new Set<ResearchStatus>([
  "completed",
  "failed",
  "cancelled",
]);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stringRecord(value: unknown): Record<string, string> {
  if (!isObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function statusValue(value: unknown): ResearchStatus {
  if (
    value === "pending" ||
    value === "initializing" ||
    value === "awaiting_clarifications" ||
    value === "collecting_answers" ||
    value === "researching" ||
    value === "completed" ||
    value === "failed" ||
    value === "cancelled"
  ) {
    return value;
  }
  return value === "started" ? "initializing" : "pending";
}

function failureStageValue(
  value: unknown,
): ResearchStatusResponse["failure_stage"] {
  return value === "initialization" ||
    value === "clarification" ||
    value === "research"
    ? value
    : null;
}

function normalizeInteraction(
  payload: JsonObject,
  workflowId: string,
): ResearchStatusResponse {
  const clarificationQuestions = stringArray(payload.clarification_questions);
  return {
    workflow_id: stringValue(payload.workflow_id) ?? workflowId,
    status: statusValue(payload.status),
    original_query: stringValue(payload.original_query),
    clarification_questions: clarificationQuestions,
    clarification_responses: stringRecord(payload.clarification_responses),
    current_question: stringValue(payload.current_question),
    current_question_index: numberValue(payload.current_question_index),
    total_questions: numberValue(
      payload.total_questions,
      clarificationQuestions.length,
    ),
    research_completed:
      payload.research_completed === true || payload.status === "completed",
    error_message: stringValue(payload.error_message),
    failure_stage: failureStageValue(payload.failure_stage),
  };
}

async function responseJson<T>(
  response: Response,
  fallback: string,
): Promise<T> {
  const raw = await response.text();
  let body: unknown = {};
  if (raw) {
    try {
      body = JSON.parse(raw) as unknown;
    } catch {
      body = {};
    }
  }

  if (!response.ok) {
    const detail =
      isObject(body) && typeof body.detail === "string"
        ? body.detail
        : fallback;
    throw new Error(detail);
  }
  return body as T;
}

export class ResearchClient {
  private workflowId: string | null = null;
  private stopActivePoll: (() => void) | null = null;

  constructor(private readonly baseUrl = window.location.origin) {}

  async startResearch(query: string): Promise<StartResearchResponse> {
    const response = await fetch(this.url("/api/start-research"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    const raw = await responseJson<JsonObject>(
      response,
      "Failed to start research",
    );
    const workflowId = stringValue(raw.workflow_id);
    if (!workflowId) throw new Error("The server did not return a workflow ID");

    this.workflowId = workflowId;
    const nested = isObject(raw.interaction) ? raw.interaction : raw;
    return {
      workflow_id: workflowId,
      status: stringValue(raw.status) ?? "started",
      temporal_ui_url: stringValue(raw.temporal_ui_url) ?? "",
      interaction: normalizeInteraction(nested, workflowId),
    };
  }

  async getStatus(
    workflowId?: string,
    signal?: AbortSignal,
  ): Promise<ResearchStatusResponse> {
    const id = this.requireWorkflowId(workflowId);
    const response = await fetch(
      this.url("/api/status/" + encodeURIComponent(id)),
      signal ? { signal } : {},
    );
    const raw = await responseJson<JsonObject>(
      response,
      "Failed to get research status",
    );
    return normalizeInteraction(raw, id);
  }

  async submitAnswer(
    answer: string,
    workflowId?: string,
    questionIndex = 0,
  ): Promise<void> {
    const id = this.requireWorkflowId(workflowId);
    const response = await fetch(
      this.url(
        "/api/answer/" +
          encodeURIComponent(id) +
          "/" +
          encodeURIComponent(String(questionIndex)),
      ),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer }),
      },
    );
    await responseJson<unknown>(response, "Failed to submit answer");
  }

  async cancelResearch(workflowId?: string): Promise<CancelResearchResponse> {
    const id = this.requireWorkflowId(workflowId);
    const response = await fetch(
      this.url("/api/cancel/" + encodeURIComponent(id)),
      { method: "POST" },
    );
    const raw = await responseJson<JsonObject>(
      response,
      "Failed to cancel research",
    );
    const nested = isObject(raw.interaction)
      ? raw.interaction
      : raw.status === "cancelled"
        ? raw
        : null;
    const result: CancelResearchResponse = {
      workflow_id: stringValue(raw.workflow_id) ?? id,
      status: stringValue(raw.status) ?? "cancellation_requested",
    };
    if (nested) result.interaction = normalizeInteraction(nested, id);
    return result;
  }

  async getResult(workflowId?: string): Promise<ResearchResultResponse> {
    const id = this.requireWorkflowId(workflowId);
    const response = await fetch(
      this.url("/api/result/" + encodeURIComponent(id)),
    );
    const raw = await responseJson<JsonObject>(
      response,
      "Research result is not available",
    );
    return {
      workflow_id: stringValue(raw.workflow_id) ?? id,
      status:
        raw.status === "failed" || raw.status === "cancelled"
          ? raw.status
          : "completed",
      error_message: stringValue(raw.error_message),
      markdown_report: stringValue(raw.markdown_report) ?? "",
      short_summary: stringValue(raw.short_summary) ?? "",
      follow_up_questions: stringArray(raw.follow_up_questions),
      image_file_path: stringValue(raw.image_file_path),
      pdf_file_path: stringValue(raw.pdf_file_path),
    };
  }

  startPolling(
    workflowId: string,
    onUpdate: (status: ResearchStatusResponse) => void | Promise<void>,
    options: PollOptions = {},
  ): () => void {
    this.stopPolling();
    this.workflowId = workflowId;

    const controller = new AbortController();
    const interval = options.interval ?? 1_500;
    const retryInterval = options.retryInterval ?? 3_000;
    let timeoutId: number | null = null;

    const stop = (): void => {
      controller.abort();
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      timeoutId = null;
      if (this.stopActivePoll === stop) this.stopActivePoll = null;
    };

    const schedule = (delay: number): void => {
      if (controller.signal.aborted) return;
      timeoutId = window.setTimeout(() => void poll(), delay);
    };

    const poll = async (): Promise<void> => {
      if (controller.signal.aborted) return;
      try {
        const status = await this.getStatus(workflowId, controller.signal);
        if (controller.signal.aborted) return;
        await onUpdate(status);
        if (terminalStatuses.has(status.status)) {
          stop();
          return;
        }
        schedule(interval);
      } catch (error) {
        if (controller.signal.aborted) return;
        const normalized =
          error instanceof Error ? error : new Error(String(error));
        await options.onError?.(normalized);
        schedule(retryInterval);
      }
    };

    this.stopActivePoll = stop;
    void poll();
    return stop;
  }

  stopPolling(): void {
    this.stopActivePoll?.();
    this.stopActivePoll = null;
  }

  private requireWorkflowId(workflowId?: string): string {
    const id = workflowId ?? this.workflowId;
    if (!id) throw new Error("No workflow ID is available");
    this.workflowId = id;
    return id;
  }

  private url(pathname: string): string {
    return new URL(pathname, this.baseUrl).toString();
  }
}

window.ResearchClient = ResearchClient;
