import DOMPurify from "dompurify";
import { marked } from "marked";

const activeWorkflowKey = "deepResearch.activeWorkflowId";
const temporalUrlKey = "deepResearch.temporalUiUrl";
const cachedResultKey = "deepResearch.result";
const cachedResultWorkflowKey = "deepResearch.resultWorkflowId";

const client = new window.ResearchClient(window.location.origin);
type ResearchResult = Awaited<ReturnType<typeof client.getResult>>;

function element<T extends Element>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (!value) throw new Error("Missing UI element: " + selector);
  return value;
}

const loadingPanel = element<HTMLElement>("#loadingPanel");
const resultPanel = element<HTMLElement>("#resultPanel");
const errorPanel = element<HTMLElement>("#resultError");
const errorTitle = element<HTMLElement>("#errorTitle");
const errorMessage = element<HTMLElement>("#errorMessage");
const workflowLink = element<HTMLAnchorElement>("#resultWorkflowLink");
const summarySection = element<HTMLElement>("#summarySection");
const summaryText = element<HTMLElement>("#summaryText");
const imageSection = element<HTMLElement>("#imageSection");
const reportImage = element<HTMLImageElement>("#reportImage");
const imageLink = element<HTMLAnchorElement>("#openImageLink");
const reportSection = element<HTMLElement>("#reportSection");
const reportButton = element<HTMLButtonElement>("#viewReportBtn");
const accordion = element<HTMLElement>("#accordionContent");
const markdownContent = element<HTMLElement>("#markdownContent");
const followUpSection = element<HTMLElement>("#followUpSection");
const followUpList = element<HTMLUListElement>("#followUpList");
const downloadPdf = element<HTMLAnchorElement>("#downloadPdfBtn");
const downloadMarkdownButton = element<HTMLButtonElement>(
  "#downloadMarkdownBtn",
);
const artifactNote = element<HTMLElement>("#artifactNote");
const startOverLink = element<HTMLAnchorElement>("#startOverLink");

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function workflowIdFromPage(): string | null {
  return (
    new URLSearchParams(window.location.search).get("wf") ||
    sessionStorage.getItem(cachedResultWorkflowKey) ||
    localStorage.getItem(activeWorkflowKey)
  );
}

function cachedResult(workflowId: string): ResearchResult | null {
  if (sessionStorage.getItem(cachedResultWorkflowKey) !== workflowId)
    return null;
  const serialized = sessionStorage.getItem(cachedResultKey);
  if (!serialized) return null;

  try {
    const value = JSON.parse(serialized) as unknown;
    if (!isObject(value) || value.workflow_id !== workflowId) return null;
    return value as unknown as ResearchResult;
  } catch {
    return null;
  }
}

function safeArtifactUrl(path: string | null): string | null {
  if (!path) return null;
  try {
    const url = new URL(path, window.location.origin);
    if (
      url.origin !== window.location.origin ||
      !url.pathname.startsWith("/artifacts/")
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

async function renderMarkdown(markdown: string): Promise<void> {
  const rendered = await marked.parse(markdown, {
    async: true,
    gfm: true,
    breaks: false,
  });
  const sanitized = DOMPurify.sanitize(rendered, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: [
      "script",
      "style",
      "iframe",
      "object",
      "embed",
      "form",
      "img",
    ],
    FORBID_ATTR: ["style"],
  });
  markdownContent.innerHTML = String(sanitized);

  for (const link of Array.from(
    markdownContent.querySelectorAll<HTMLAnchorElement>("a"),
  )) {
    link.target = "_blank";
    link.rel = "noopener noreferrer";
  }
}

function downloadMarkdown(content: string, workflowId: string): void {
  const url = URL.createObjectURL(
    new Blob([content], { type: "text/markdown;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "research-report-" + workflowId + ".md";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function showLoadError(title: string, message: string): void {
  loadingPanel.hidden = true;
  resultPanel.hidden = true;
  errorTitle.textContent = title;
  errorMessage.textContent = message;
  errorPanel.hidden = false;
}

function renderTerminalResult(result: ResearchResult): void {
  const cancelled = result.status === "cancelled";
  showLoadError(
    cancelled ? "Research was cancelled" : "Research failed",
    result.error_message ||
      result.short_summary ||
      (cancelled
        ? "This workflow ended before a report was created."
        : "The workflow could not create a report."),
  );
}

async function renderResult(
  result: ResearchResult,
  workflowId: string,
): Promise<void> {
  if (result.status === "failed" || result.status === "cancelled") {
    renderTerminalResult(result);
    return;
  }

  const temporalUrl = localStorage.getItem(temporalUrlKey);
  if (temporalUrl) {
    workflowLink.href = temporalUrl;
    workflowLink.textContent = "View workflow " + workflowId;
    workflowLink.hidden = false;
  }

  if (result.short_summary.trim()) {
    summaryText.textContent = result.short_summary;
    summarySection.hidden = false;
  }

  const missingArtifacts: string[] = [];
  const imageUrl = safeArtifactUrl(result.image_file_path);
  if (imageUrl) {
    reportImage.src = imageUrl;
    imageLink.href = imageUrl;
    imageSection.hidden = false;
    reportImage.addEventListener(
      "error",
      () => {
        imageSection.hidden = true;
        missingArtifacts.push("The generated image could not be loaded.");
        artifactNote.textContent = missingArtifacts.join(" ");
        artifactNote.hidden = false;
      },
      { once: true },
    );
  } else {
    missingArtifacts.push("No generated image is available.");
  }

  if (result.markdown_report.trim()) {
    await renderMarkdown(result.markdown_report);
    reportSection.hidden = false;
    downloadMarkdownButton.hidden = false;
    downloadMarkdownButton.addEventListener("click", () => {
      downloadMarkdown(result.markdown_report, workflowId);
    });
  } else {
    missingArtifacts.push("No Markdown report is available.");
  }

  if (result.follow_up_questions.length > 0) {
    followUpList.replaceChildren(
      ...result.follow_up_questions.map((question) => {
        const item = document.createElement("li");
        item.textContent = question;
        return item;
      }),
    );
    followUpSection.hidden = false;
  }

  const pdfUrl = safeArtifactUrl(result.pdf_file_path);
  if (pdfUrl) {
    downloadPdf.href = pdfUrl;
    downloadPdf.download = "research-report.pdf";
    downloadPdf.hidden = false;
  } else {
    missingArtifacts.push("No PDF report is available.");
  }

  if (missingArtifacts.length > 0) {
    artifactNote.textContent = missingArtifacts.join(" ");
    artifactNote.hidden = false;
  }

  loadingPanel.hidden = true;
  resultPanel.hidden = false;
}

async function loadResearchResult(): Promise<void> {
  const workflowId = workflowIdFromPage();
  if (!workflowId) {
    showLoadError(
      "No research result selected",
      "Return to the research page and start a new workflow.",
    );
    return;
  }

  try {
    const result =
      cachedResult(workflowId) ?? (await client.getResult(workflowId));
    await renderResult(result, workflowId);
  } catch (error) {
    showLoadError(
      "Unable to load the report",
      error instanceof Error
        ? error.message
        : "The research result is not available.",
    );
  }
}

reportButton.addEventListener("click", () => {
  const expanded = reportButton.getAttribute("aria-expanded") === "true";
  reportButton.setAttribute("aria-expanded", String(!expanded));
  accordion.hidden = expanded;
  reportButton.querySelector(".chevron")?.classList.toggle("open", !expanded);
  const label = reportButton.querySelector<HTMLElement>(".report-button-label");
  if (label)
    label.textContent = expanded ? "View full report" : "Hide full report";
});

startOverLink.addEventListener("click", () => {
  localStorage.removeItem(activeWorkflowKey);
  localStorage.removeItem(temporalUrlKey);
  sessionStorage.removeItem(cachedResultKey);
  sessionStorage.removeItem(cachedResultWorkflowKey);
});

void loadResearchResult();
