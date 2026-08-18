export interface Clarifications {
  questions: string[];
}

export interface WebSearchItem {
  reason: string;
  query: string;
}

export interface WebSearchPlan {
  searches: WebSearchItem[];
}

export interface ResearchSource {
  title: string;
  url: string;
}

export interface WebSearchResult {
  query: string;
  summary: string;
  sources: ResearchSource[];
}

export interface ReportData {
  short_summary: string;
  markdown_report: string;
  follow_up_questions: string[];
}

export interface ImageGenData {
  success: boolean;
  image_description: string;
  image_file_path: string | null;
  notes: string;
  error_message: string | null;
}

export interface PDFReportData {
  success: boolean;
  formatting_notes: string;
  pdf_file_path: string | null;
  error_message: string | null;
}

export interface ClarificationResult {
  needs_clarifications: boolean;
  questions?: string[];
}

export interface ClarificationInput {
  responses: Record<string, string>;
}

export interface SingleClarificationInput {
  question_index: number;
  answer: string;
}

export interface UserQueryInput {
  query: string;
}

export type ResearchStatus =
  | "pending"
  | "initializing"
  | "awaiting_clarifications"
  | "collecting_answers"
  | "researching"
  | "completed"
  | "failed"
  | "cancelled";

export type ResearchFailureStage =
  "initialization" | "clarification" | "research" | null;

export interface ResearchInteraction {
  original_query: string | null;
  clarification_questions: string[];
  clarification_responses: Record<string, string>;
  current_question_index: number;
  current_question: string | null;
  status: ResearchStatus;
  research_completed: boolean;
  error_message: string | null;
  failure_stage: ResearchFailureStage;
}

export interface InteractiveResearchResult extends ReportData {
  status: "completed" | "failed" | "cancelled";
  error_message: string | null;
  image_file_path: string | null;
  pdf_file_path: string | null;
}

export interface ProcessClarificationInput {
  answer: string;
  current_question_index: number;
  current_question: string | null;
  total_questions: number;
}

export interface ProcessClarificationResult {
  question_key: string;
  answer: string;
  new_index: number;
}

export interface ImageStylingOptions {
  size?: "1024x1024" | "1536x1024" | "1024x1536" | "auto";
  output_format?: "png" | "jpeg" | "webp";
  output_compression?: number | null;
  resize_width?: number | null;
}

export interface ImageGenerationResult {
  image_file_path: string | null;
  mime_type: string;
  success: boolean;
  error_message: string | null;
}

export interface PDFStylingOptions {
  font_size?: number | null;
  primary_color?: string | null;
}

export interface PDFGenerationInput {
  markdown_content: string;
  title?: string;
  styling_options?: PDFStylingOptions;
  image_file_path?: string | null;
}

export interface PDFGenerationResult {
  pdf_file_path: string;
  success: boolean;
  error_message: string | null;
}
