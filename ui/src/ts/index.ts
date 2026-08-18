const activeWorkflowKey = "deepResearch.activeWorkflowId";
const temporalUrlKey = "deepResearch.temporalUiUrl";
const cachedResultKey = "deepResearch.result";
const cachedResultWorkflowKey = "deepResearch.resultWorkflowId";

const client = new window.ResearchClient(window.location.origin);

function element<T extends Element>(selector: string): T {
  const value = document.querySelector<T>(selector);
  if (!value) throw new Error("Missing UI element: " + selector);
  return value;
}

const chatContainer = element<HTMLElement>("#chatContainer");
const researchForm = element<HTMLFormElement>("#researchForm");
const userInput = element<HTMLInputElement>("#researchInput");
const submitButton = element<HTMLButtonElement>("#submitButton");
const spinnerContainer = element<HTMLElement>("#spinnerContainer");
const statusText = element<HTMLElement>("#statusText");
const workflowLink = element<HTMLAnchorElement>("#workflowIdLink");
const cancelButton = element<HTMLButtonElement>("#cancelButton");
const terminalPanel = element<HTMLElement>("#terminalPanel");
const terminalTitle = element<HTMLElement>("#terminalTitle");
const terminalMessage = element<HTMLElement>("#terminalMessage");
const startNewButton = element<HTMLButtonElement>("#startNewButton");

let workflowId: string | null = null;
let temporalUiUrl = "";
let currentQuestionIndex = 0;
let lastQuestionKey: string | null = null;
let lastStatus: string | null = null;
let busy = false;
let acceptingInput = true;
let terminal = false;
let completing = false;
let stopPolling: (() => void) | null = null;

function addMessage(
  text: string,
  role: "bot" | "user" = "bot",
  tone: "default" | "error" = "default",
): void {
  const message = document.createElement("div");
  message.className = "message " + role;

  const bubble = document.createElement("div");
  bubble.className =
    "message-bubble " + role + (tone === "error" ? " error" : "");
  bubble.textContent = text;

  message.appendChild(bubble);
  chatContainer.appendChild(message);
  chatContainer.scrollTop = chatContainer.scrollHeight;
}

function resetConversation(): void {
  chatContainer.replaceChildren();
  addMessage("Hey there — what would you like me to research?");
}

function showSpinner(visible: boolean, text = "Working…"): void {
  spinnerContainer.hidden = !visible;
  statusText.textContent = text;
}

function updateControls(): void {
  const disabled = busy || !acceptingInput || terminal;
  userInput.disabled = disabled;
  submitButton.disabled = disabled;
  cancelButton.disabled = busy;
  if (!disabled) window.setTimeout(() => userInput.focus(), 0);
}

function setBusy(value: boolean): void {
  busy = value;
  updateControls();
}

function setAcceptingInput(value: boolean): void {
  acceptingInput = value;
  updateControls();
}

function displayWorkflowLink(): void {
  if (!workflowId || !temporalUiUrl) {
    workflowLink.hidden = true;
    workflowLink.removeAttribute("href");
    workflowLink.textContent = "";
    return;
  }
  workflowLink.href = temporalUiUrl;
  workflowLink.textContent = "View workflow " + workflowId;
  workflowLink.hidden = false;
}

function persistWorkflow(id: string, url: string): void {
  workflowId = id;
  temporalUiUrl = url;
  localStorage.setItem(activeWorkflowKey, id);
  if (url) localStorage.setItem(temporalUrlKey, url);
  else localStorage.removeItem(temporalUrlKey);
  displayWorkflowLink();
  cancelButton.hidden = false;
}

function clearPersistedWorkflow(): void {
  localStorage.removeItem(activeWorkflowKey);
  localStorage.removeItem(temporalUrlKey);
}

function stopStatusPolling(): void {
  stopPolling?.();
  stopPolling = null;
  client.stopPolling();
}

function isTerminalStatus(status: string): boolean {
  return (
    status === "completed" || status === "failed" || status === "cancelled"
  );
}

function beginPolling(): void {
  if (!workflowId || terminal) return;
  stopStatusPolling();
  stopPolling = client.startPolling(workflowId, handleStatus, {
    interval: 1_500,
    retryInterval: 3_000,
    onError: () => {
      if (!terminal) {
        showSpinner(true, "Connection interrupted. Retrying…");
      }
    },
  });
}

function restoreConversation(
  status: Awaited<ReturnType<typeof client.getStatus>>,
): void {
  chatContainer.replaceChildren();
  addMessage("Welcome back — resuming your research session.");

  if (status.original_query) addMessage(status.original_query, "user");

  const answeredCount = Math.min(
    status.current_question_index,
    status.clarification_questions.length,
  );
  for (let index = 0; index < answeredCount; index += 1) {
    const question = status.clarification_questions[index];
    const answer = status.clarification_responses["question_" + index];
    if (question) addMessage(question);
    if (answer) addMessage(answer, "user");
  }
}

async function finishCompletedResearch(): Promise<void> {
  if (!workflowId || completing) return;
  completing = true;
  setAcceptingInput(false);
  showSpinner(true, "Preparing your report…");

  try {
    const result = await client.getResult(workflowId);
    sessionStorage.setItem(cachedResultKey, JSON.stringify(result));
    sessionStorage.setItem(cachedResultWorkflowKey, workflowId);
    window.location.assign("/success?wf=" + encodeURIComponent(workflowId));
  } catch (error) {
    completing = false;
    throw error;
  }
}

function showTerminal(
  status: "failed" | "cancelled",
  message: string | null,
): void {
  if (terminal) return;
  terminal = true;
  stopStatusPolling();
  showSpinner(false);
  setAcceptingInput(false);
  setBusy(false);
  clearPersistedWorkflow();

  cancelButton.hidden = true;
  researchForm.hidden = true;
  terminalPanel.dataset.status = status;
  terminalPanel.hidden = false;

  if (status === "failed") {
    terminalTitle.textContent = "Research failed";
    terminalMessage.textContent =
      message ||
      "The research workflow could not finish. You can start a new session.";
    addMessage(
      message
        ? "Research failed: " + message
        : "Research failed before a report could be created.",
      "bot",
      "error",
    );
  } else {
    terminalTitle.textContent = "Research cancelled";
    terminalMessage.textContent =
      "This workflow has stopped. Start a new session whenever you are ready.";
    addMessage("Research cancelled. No report was created.");
  }
}

async function handleStatus(
  status: Awaited<ReturnType<typeof client.getStatus>>,
): Promise<void> {
  const previousStatus = lastStatus;
  lastStatus = status.status;
  currentQuestionIndex = status.current_question_index;

  switch (status.status) {
    case "pending":
    case "initializing":
      setAcceptingInput(false);
      showSpinner(true, "Preparing your research plan…");
      break;

    case "awaiting_clarifications":
    case "collecting_answers": {
      showSpinner(false);
      const question = status.current_question;
      if (!question) {
        setAcceptingInput(false);
        showSpinner(true, "Preparing the next step…");
        break;
      }

      const questionKey =
        String(status.current_question_index) + ":" + question;
      if (questionKey !== lastQuestionKey) {
        addMessage(question);
        lastQuestionKey = questionKey;
      }
      userInput.placeholder = "Reply to the question…";
      setAcceptingInput(true);
      break;
    }

    case "researching":
      setAcceptingInput(false);
      showSpinner(true, "Searching, analyzing, and writing your report…");
      if (previousStatus !== "researching") {
        addMessage(
          "Thanks — I have what I need. I’m researching your topic now.",
        );
      }
      break;

    case "completed":
      stopStatusPolling();
      cancelButton.hidden = true;
      await finishCompletedResearch();
      break;

    case "failed":
      showTerminal("failed", status.error_message);
      break;

    case "cancelled":
      showTerminal("cancelled", null);
      break;
  }
}

async function handleSubmit(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  if (busy || terminal) return;

  const text = userInput.value.trim();
  if (!text) return;
  addMessage(text, "user");
  userInput.value = "";
  setBusy(true);
  setAcceptingInput(false);

  try {
    if (!workflowId) {
      showSpinner(true, "Starting durable research…");
      const started = await client.startResearch(text);
      persistWorkflow(started.workflow_id, started.temporal_ui_url);
      setBusy(false);
      await handleStatus(started.interaction);
    } else {
      stopStatusPolling();
      showSpinner(true, "Saving your answer…");
      await client.submitAnswer(text, workflowId, currentQuestionIndex);
      setBusy(false);
      showSpinner(true, "Preparing the next step…");
    }

    if (workflowId && !terminal && !isTerminalStatus(lastStatus ?? "")) {
      beginPolling();
    }
  } catch (error) {
    setBusy(false);
    showSpinner(false);
    const message =
      error instanceof Error
        ? error.message
        : "Something went wrong. Please try again.";
    addMessage(message, "bot", "error");

    if (workflowId) {
      const canAnswer =
        lastStatus === "awaiting_clarifications" ||
        lastStatus === "collecting_answers";
      setAcceptingInput(canAnswer);
      beginPolling();
    } else {
      setAcceptingInput(true);
    }
  }
}

async function handleCancel(): Promise<void> {
  if (!workflowId || busy || terminal) return;
  if (!window.confirm("Cancel this research workflow?")) return;

  stopStatusPolling();
  setBusy(true);
  setAcceptingInput(false);
  showSpinner(true, "Cancelling research…");

  try {
    const response = await client.cancelResearch(workflowId);
    setBusy(false);
    if (response.interaction) await handleStatus(response.interaction);
    if (!terminal) {
      showSpinner(true, "Waiting for the workflow to stop…");
      beginPolling();
    }
  } catch (error) {
    setBusy(false);
    const message =
      error instanceof Error ? error.message : "Unable to cancel research.";
    addMessage(message, "bot", "error");
    beginPolling();
  }
}

function resetSession(): void {
  stopStatusPolling();
  clearPersistedWorkflow();
  sessionStorage.removeItem(cachedResultKey);
  sessionStorage.removeItem(cachedResultWorkflowKey);

  workflowId = null;
  temporalUiUrl = "";
  currentQuestionIndex = 0;
  lastQuestionKey = null;
  lastStatus = null;
  busy = false;
  acceptingInput = true;
  terminal = false;
  completing = false;

  terminalPanel.hidden = true;
  terminalPanel.removeAttribute("data-status");
  researchForm.hidden = false;
  cancelButton.hidden = true;
  workflowLink.hidden = true;
  userInput.value = "";
  userInput.placeholder = "What would you like to research?";
  displayWorkflowLink();
  showSpinner(false);
  resetConversation();
  updateControls();
}

async function resumeExistingWorkflow(): Promise<void> {
  const storedWorkflowId = localStorage.getItem(activeWorkflowKey);
  if (!storedWorkflowId) {
    updateControls();
    userInput.focus();
    return;
  }

  workflowId = storedWorkflowId;
  temporalUiUrl = localStorage.getItem(temporalUrlKey) ?? "";
  displayWorkflowLink();
  cancelButton.hidden = false;
  setAcceptingInput(false);
  setBusy(true);
  showSpinner(true, "Resuming your research session…");

  try {
    const status = await client.getStatus(storedWorkflowId);
    restoreConversation(status);
    setBusy(false);
    await handleStatus(status);
    if (!terminal && !isTerminalStatus(status.status)) beginPolling();
  } catch (error) {
    clearPersistedWorkflow();
    workflowId = null;
    temporalUiUrl = "";
    setBusy(false);
    setAcceptingInput(true);
    showSpinner(false);
    displayWorkflowLink();
    cancelButton.hidden = true;
    resetConversation();
    addMessage(
      error instanceof Error
        ? "The previous session could not be resumed: " + error.message
        : "The previous session could not be resumed.",
      "bot",
      "error",
    );
  }
}

researchForm.addEventListener("submit", (event) => {
  void handleSubmit(event);
});
cancelButton.addEventListener("click", () => void handleCancel());
startNewButton.addEventListener("click", resetSession);
window.addEventListener("beforeunload", () => client.stopPolling());

void resumeExistingWorkflow();
