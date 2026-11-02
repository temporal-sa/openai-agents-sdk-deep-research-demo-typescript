# Runbook: OpenAI deep research demo (TypeScript)

This runbook is for presenting the demo. The [README](README.md) explains what it is and how it's built.

## What it shows

You ask for research, answer a few clarifying questions, and get a cited Markdown report with a generated image and a PDF. OpenAI Agents SDK agents do the thinking; one Temporal Workflow holds the conversation, waits for your answers, runs the agents as Activities, and keeps going through failures and restarts.

The demo makes three problems visible:

- **Research needs a person's answers, and people are slow or walk away.** The Workflow asks its questions and waits up to 30 minutes for the answers, with nothing held in the web server's memory. Beat 3 closes the tab, or restarts the process, while it waits.
- **Model calls fail.** Each agent runs in an Activity that Temporal retries. Beat 2 makes one answer fail three times on purpose, and the conversation carries on.
- **A big fan-out shouldn't fail because one piece did.** The planner asks for 5 to 20 web searches, which run in parallel with the image. A failed search is left out, and a failed image or PDF leaves the Markdown report intact. Beat 4 shows the fan-out.

## Before you start

- Install Node.js 22 (the repository has an `.nvmrc`) and the [Temporal CLI](https://docs.temporal.io/cli).
- You need an OpenAI API key with access to the text models, the web search tool and `gpt-image-1`. Image generation may need a verified OpenAI organization; without it the report still completes, without an image. Every run makes paid OpenAI calls.
- From the repository root:

  ```bash
  nvm install && nvm use
  npm ci
  cp .env-sample .env
  ```

  Edit `.env` and set `OPENAI_API_KEY`. The sample points at a local Temporal server, serves on port 8234, writes images and PDFs under `./artifacts`, and sets `BYPASS_TRIAGE_AGENT=Y` so every run asks clarifying questions. Keep that setting for presenting; the retry in beat 2 depends on the questions.

### On Temporal Cloud

- To run your own copy against Temporal Cloud, set `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE`, `TEMPORAL_API_KEY` and `TEMPORAL_TASK_QUEUE` in `.env`. An API key turns on TLS. See the README's [Temporal Cloud](README.md#temporal-cloud-outside-the-demo-registry) section.
- The hosted copy runs at https://openai-deep-research-ts.tmprl-demo.cloud behind Temporal sign-in, for `@temporal.io` accounts. The platform supplies the Temporal credentials and the OpenAI key, runs the Worker, and sets `BYPASS_TRIAGE_AGENT=Y`. You can't restart that Worker, so the restart in beat 3 works only on a local copy; the tab-close half works on both.
- The **View workflow** link opens the run in Temporal Cloud. You need access to the demo's Namespace to follow it.
- Each signed-in user can start 5 runs an hour. Plan rehearsals around it.
- The hosted copy keeps images and PDFs on the pod's disk, so they can disappear when the pod is replaced.

## Start it

In two terminals, from the repository root:

1. `temporal server start-dev` (skip this on Temporal Cloud)
2. `npm run dev`

`npm run dev` builds the browser code, then runs the UI, the API and the Worker in one process. A healthy start prints `Worker configured for task queue research-queue` and `Research UI listening on http://0.0.0.0:8234`, and http://localhost:8234/api/ready returns `{"status":"ready","temporal":"connected"}`.

Open http://localhost:8234. The page shows **Durable Deep Research** and the message "Hey there — what would you like me to research?" The Temporal UI is at http://localhost:8233.

## The walkthrough

### 1. Ask for research

1. Type a topic in **What would you like to research?** and press Enter, or click the arrow button. A narrow topic keeps the run short and cheap.
2. The page says "Starting durable research…", then "Preparing your research plan…" while the triage and clarifying agents run. A **View workflow interactive-research-…** link appears under the title. Then the first clarifying question appears as a chat message.
3. Say: "That started a Temporal Workflow and handed it my topic. An agent is writing questions for me, and the Workflow will wait for my answers."
4. For proof, click **View workflow interactive-research-…**. The history shows the `startResearch` Update and the `determineClarifications` Activity that ran inside it.

### 2. Answer the questions; one answer fails and retries

1. Type an answer to each question and press Enter. Each answer shows "Saving your answer…", then the next question.
2. The second-to-last answer takes longer: "Saving your answer…" stays for about half a minute. The demo makes that answer's Activity fail three times before it succeeds.
3. Say: "That answer just failed three times. Temporal retried it with backoff, and the conversation didn't notice. Each answer is an Update: the browser waits for the Workflow to confirm it, so I know it was saved."
4. For proof, open the Temporal UI while it waits. The pending `processClarification` Activity shows its attempt count rising and the last failure, "Simulated failure -- try again soon :)". After it succeeds, the history shows the Update accepted and completed.

The clarifying agent asks one to three questions. With one question, nothing fails; ask a broader topic if you want the retry.

### 3. Walk away in the middle of the questions

1. While a question is waiting for an answer, close the tab.
2. Open http://localhost:8234 again. The page says "Welcome back — resuming your research session." and rebuilds the conversation: your topic, the questions you answered, your answers, and the question that's waiting.
3. On a local copy you can go further: press `Ctrl-C` in the `npm run dev` terminal, run `npm run dev` again, and reload the page. The conversation comes back the same way.
4. Say: "The conversation isn't in the browser or the web server. It's in the Workflow, which is waiting on a 30-minute timer for my answer. The page asked the Workflow where we were."
5. For proof, the history shows a Timer started for 30 minutes.

### 4. Watch the research fan out

1. Answer the last question. The page says "Thanks — I have what I need. I'm researching your topic now." with the spinner "Searching, analyzing, and writing your report…".
2. In the Temporal UI, the history shows `createResearchInstructions`, then `generateResearchImage` and `planSearches` together, then one `performSearch` per planned search, all at once, then `writeReport` and `generatePdf`.
3. Say: "The planner asked for between 5 and 20 searches, and they all run in parallel, alongside the image. If one search fails for good, the report is written from the rest."

### 5. Read the report

1. When the run completes, the page moves to **Research complete**. It shows the **Executive summary**, the generated image, the full report (toggle it with **Hide full report** / **View full report**), **Questions to explore next**, **Download PDF report** and **Download Markdown report**.
2. If the image or PDF failed, the page says so under the buttons, and the Markdown report is still there.
3. Say: "The report, the image path and the PDF path are the Workflow's result. Temporal keeps it, so this page can fetch it again later."

### 6. Optional: cancel a run

1. Start a run, and during the questions or the research click **Cancel research**, then confirm "Cancel this research workflow?".
2. The page shows **Research cancelled** straight away.
3. Say: "Cancel is a Signal to the Workflow. It marks the run cancelled and cancels the research it has in flight."
4. In the Temporal UI, the run closes as **Completed**, not Canceled: the Workflow returns a result whose status is `cancelled`. If research was running, the run stays open until the Activities already running finish, because they don't heartbeat and so don't hear the cancel.

## Show it in code

All links point at commit [`98f0b90`](https://github.com/temporal-sa/openai-agents-sdk-deep-research-demo-typescript/commit/98f0b90df7f85a2864eb83b117f32d8e7487b45b). Open a file locally with `code -g <path>:<line>`.

### Start the Workflow and hand it the topic

**When to use it:** after beat 1, or when someone asks how the web app talks to Temporal.

**Where it is:** [`src/server/main.ts` lines 356–367](https://github.com/temporal-sa/openai-agents-sdk-deep-research-demo-typescript/blob/98f0b90df7f85a2864eb83b117f32d8e7487b45b/src/server/main.ts#L356-L367) (`code -g src/server/main.ts:356`), handled in [`src/workflows/interactive-research-workflow.ts` lines 237–270](https://github.com/temporal-sa/openai-agents-sdk-deep-research-demo-typescript/blob/98f0b90df7f85a2864eb83b117f32d8e7487b45b/src/workflows/interactive-research-workflow.ts#L237-L270)

```ts
const workflowId = `interactive-research-${randomUUID().slice(0, 8)}`;
const handle = await client.workflow.start(interactiveResearchWorkflow, {
  workflowId,
  taskQueue: config.taskQueue,
  args: [],
});

try {
  await handle.startUpdate(startResearchUpdate, {
    args: [{ query }],
    waitForStage: WorkflowUpdateStage.ACCEPTED,
  });
```

```ts
setHandler(
  startResearchUpdate,
  async (input) => {
    state.originalQuery = input.query.trim();
    state.status = "initializing";
    // ...
    try {
      const clarification = await researchActivities.determineClarifications(
        state.originalQuery,
      );
      state.clarificationQuestions = clarification.questions ?? [];
      // ...
    }
    // ...
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
```

**What you need to understand:**

- The API starts an empty Workflow, then sends the topic as an Update. `waitForStage: ACCEPTED` returns as soon as the Workflow accepts it, so the HTTP request doesn't wait for the triage and clarifying agents. The browser polls for the questions.
- An Update handler can run Activities. This one runs the triage and clarifying agents and stores the questions in Workflow state.
- The validator runs first. A second topic for the same run is rejected, and a rejected Update leaves no event in the history.

**Docs:** [TypeScript: message passing](https://docs.temporal.io/develop/typescript/workflows/message-passing), [Updates](https://docs.temporal.io/sending-messages#sending-updates)

### Take each answer as an Update

**When to use it:** during beat 2, or when someone asks how the answers reach the Workflow.

**Where it is:** [`src/workflows/interactive-research-workflow.ts` lines 272–305](https://github.com/temporal-sa/openai-agents-sdk-deep-research-demo-typescript/blob/98f0b90df7f85a2864eb83b117f32d8e7487b45b/src/workflows/interactive-research-workflow.ts#L272-L305) (`code -g src/workflows/interactive-research-workflow.ts:272`), sent from [`src/server/main.ts` lines 408–413](https://github.com/temporal-sa/openai-agents-sdk-deep-research-demo-typescript/blob/98f0b90df7f85a2864eb83b117f32d8e7487b45b/src/server/main.ts#L408-L413)

```ts
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
      // ...
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
```

<!-- prettier-ignore -->
```ts
const status = await handle.executeUpdate(
  provideSingleClarificationUpdate,
  {
    args: [{ question_index: questionIndex, answer }],
  },
);
```

**What you need to understand:**

- `executeUpdate` waits until the handler returns, so the browser gets the new state back, or an error, in the same request. That's why "Saving your answer…" stays up during the retries in beat 2.
- The validator rejects an empty answer, an answer when no question is waiting, and an answer to a question that's already been answered (the index check), for example from a second tab or a double submit.
- The handler runs an Activity, so a failure inside it is retried by Temporal like any other Activity. The answer counts only once the Activity succeeds.
- A Signal can't return a result or be rejected, which is why answers use Updates and cancel uses a Signal.

**Docs:** [TypeScript: Update handlers and validators](https://docs.temporal.io/develop/typescript/workflows/message-passing#updates)

### Wait for the answers, for up to 30 minutes

**When to use it:** during beat 3, or when someone asks what holds the conversation while the person is away.

**Where it is:** [`src/workflows/interactive-research-workflow.ts` lines 363–381](https://github.com/temporal-sa/openai-agents-sdk-deep-research-demo-typescript/blob/98f0b90df7f85a2864eb83b117f32d8e7487b45b/src/workflows/interactive-research-workflow.ts#L363-L381) (`code -g src/workflows/interactive-research-workflow.ts:363`)

```ts
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
```

**What you need to understand:**

- `condition` waits until every question has an answer or the run is cancelled, with a durable 30-minute timer. It returns `false` if the timer fires first.
- While it waits, no process holds the conversation. The Worker can restart, and the timer and the answers so far are in the history.
- The 30 minutes is a choice for a demo. A real approval step could wait days with the same code.
- The browser rebuilds the conversation in beat 3 by calling the `getStatus` Query ([line 229](https://github.com/temporal-sa/openai-agents-sdk-deep-research-demo-typescript/blob/98f0b90df7f85a2864eb83b117f32d8e7487b45b/src/workflows/interactive-research-workflow.ts#L229)), which reads Workflow state without adding events to the history.

**Docs:** [TypeScript: condition](https://typescript.temporal.io/api/namespaces/workflow#condition), [Queries](https://docs.temporal.io/sending-messages#sending-queries)

### Give each kind of call its own timeouts and retries

**When to use it:** after beat 2, or when someone asks how many times a call is retried.

**Where it is:** [`src/workflows/interactive-research-workflow.ts` lines 32–73](https://github.com/temporal-sa/openai-agents-sdk-deep-research-demo-typescript/blob/98f0b90df7f85a2864eb83b117f32d8e7487b45b/src/workflows/interactive-research-workflow.ts#L32-L73) (`code -g src/workflows/interactive-research-workflow.ts:32`)

```ts
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
// ...
```

**What you need to understand:**

- The same Activities are proxied four ways: research agents (5 minutes per attempt, 10 minutes in total, 5 attempts), clarification (30 seconds, 5 attempts), image (10 minutes per attempt, 3 attempts) and PDF (1 minute, 3 attempts). The Workflow picks the settings by which proxy it calls through.
- In beat 2, attempts 1 to 3 of the answer fail and attempt 4 succeeds, inside the 5-attempt limit. Most of the half minute is the demo's own 10-second pause before attempts 2 and 3 fail; the backoff between attempts is 1, 2 and 4 seconds.
- `startToCloseTimeout` is also how long Temporal waits before retrying an attempt whose Worker died without reporting back.
- The Agents SDK uses the OpenAI client's default of 2 retries, so an attempt can already include retries of its own before Temporal sees a failure.

**Docs:** [Retry Policies](https://docs.temporal.io/encyclopedia/retry-policies), [Activity timeouts](https://docs.temporal.io/encyclopedia/detecting-activity-failures)

### Fan out the searches, and keep going without the ones that fail

**When to use it:** during beat 4.

**Where it is:** [`src/workflows/interactive-research-workflow.ts` lines 135–171](https://github.com/temporal-sa/openai-agents-sdk-deep-research-demo-typescript/blob/98f0b90df7f85a2864eb83b117f32d8e7487b45b/src/workflows/interactive-research-workflow.ts#L135-L171) (`code -g src/workflows/interactive-research-workflow.ts:135`)

```ts
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
```

**What you need to understand:**

- The image Activity starts without `await`, so it runs while the searches do. The Workflow awaits it only after the report is written.
- `Promise.all` over the planned searches schedules them all at once. A search that fails after its 5 attempts, or its 10-minute total, becomes `null` and is left out. The run fails only if every search fails.
- `isCancellation` rethrows cancellations, so a cancelled run doesn't look like a run where every search failed.
- The PDF uses the same pattern (lines 179–189). When it fails, the report is still returned.

**Docs:** [Parallel Execution pattern](https://docs.temporal.io/design-patterns/parallel-execution)

### Each agent runs inside an Activity

**When to use it:** when someone asks where the OpenAI Agents SDK fits.

**Where it is:** [`src/activities/research-activities.ts` lines 60–71](https://github.com/temporal-sa/openai-agents-sdk-deep-research-demo-typescript/blob/98f0b90df7f85a2864eb83b117f32d8e7487b45b/src/activities/research-activities.ts#L60-L71) (`code -g src/activities/research-activities.ts:60`) and [`src/agents/search-agent.ts` lines 24–32](https://github.com/temporal-sa/openai-agents-sdk-deep-research-demo-typescript/blob/98f0b90df7f85a2864eb83b117f32d8e7487b45b/src/agents/search-agent.ts#L24-L32)

```ts
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
```

```ts
export function newSearchAgent(): Agent<unknown, typeof searchSummarySchema> {
  return new Agent({
    name: "Search agent",
    instructions,
    tools: [webSearchTool()],
    modelSettings: { toolChoice: "required" },
    outputType: searchSummarySchema,
  });
}
```

**What you need to understand:**

- Each Activity calls the Agents SDK's `run()` for one agent, with a Zod `outputType`, and returns the typed output. Temporal records that output, so a replay or a retry of a later step doesn't run the agent again.
- The Workflow file only imports Activity types. The agents, the OpenAI client and the file writes never load in the Workflow sandbox.
- An agent's whole run, including the hosted web search tool's calls, is one Activity attempt. A retry reruns the agent from the start.
- The search agent sets no model, so the Agents SDK default applies (`gpt-4.1` in the pinned version, unless `OPENAI_DEFAULT_MODEL` is set). The others name theirs: `gpt-4o-mini` for triage, questions, instructions and the image concept, `gpt-4o` for the plan, `o3-mini` for the report.

**Docs:** [Activities](https://docs.temporal.io/activities), [OpenAI Agents SDK for TypeScript](https://openai.github.io/openai-agents-js/)

### Cancel with a Signal and a cancellation scope

**When to use it:** during beat 6.

**Where it is:** [`src/workflows/interactive-research-workflow.ts` lines 217–235](https://github.com/temporal-sa/openai-agents-sdk-deep-research-demo-typescript/blob/98f0b90df7f85a2864eb83b117f32d8e7487b45b/src/workflows/interactive-research-workflow.ts#L217-L235) (`code -g src/workflows/interactive-research-workflow.ts:217`)

```ts
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
```

**What you need to understand:**

- The **Cancel research** button sends the `endWorkflow` Signal. The handler marks the state cancelled, which the page reads back at once, and cancels the scope the research runs in.
- Cancelling the scope requests cancellation of every Activity started in it. The default cancellation type waits for each Activity to confirm, and these Activities don't heartbeat, so the Workflow waits for the ones already running to finish. No later step starts.
- The Workflow then returns a normal result with status `cancelled`, so Temporal shows the run as Completed. The same goes for a failed run: the Workflow returns a `failed` result rather than failing. Read the result to tell them apart.
- To stop the OpenAI calls themselves, the Activities would need to heartbeat and pass the cancellation on to the SDK.

**Docs:** [TypeScript: cancellation scopes](https://docs.temporal.io/develop/typescript/workflows/cancellation-scopes), [Activity cancellation](https://docs.temporal.io/activity-execution#cancellation)

### Give up on an image that can never succeed

**When to use it:** when the image is missing, or when someone asks about errors that shouldn't be retried.

**Where it is:** [`src/activities/image-generation.ts` lines 21–28](https://github.com/temporal-sa/openai-agents-sdk-deep-research-demo-typescript/blob/98f0b90df7f85a2864eb83b117f32d8e7487b45b/src/activities/image-generation.ts#L21-L28) and [lines 102–111](https://github.com/temporal-sa/openai-agents-sdk-deep-research-demo-typescript/blob/98f0b90df7f85a2864eb83b117f32d8e7487b45b/src/activities/image-generation.ts#L102-L111) (`code -g src/activities/image-generation.ts:21`)

```ts
const nonRetryableIndicators = [
  "organization must be verified",
  "403",
  "invalid_request_error",
  "insufficient_quota",
  "invalid_api_key",
  "serialization",
];
```

```ts
if (
  nonRetryableIndicators.some((indicator) =>
    message.toLowerCase().includes(indicator.toLowerCase()),
  )
) {
  throw ApplicationFailure.nonRetryable(
    `Image generation failed: ${message}`,
    "ImageGenerationError",
  );
}
```

**What you need to understand:**

- An unverified organization or a bad key won't fix itself on retry. `ApplicationFailure.nonRetryable` tells Temporal to stop after this attempt, and the Workflow carries on without an image.
- Every other error is rethrown as is, and Temporal retries it under the image proxy's 3-attempt limit.
- Matching on message text is quick for a demo. In production, check the error type or status code the OpenAI client returns.

**Docs:** [Non-retryable errors](https://docs.temporal.io/encyclopedia/retry-policies#non-retryable-errors)

### What's demo-only

When someone asks what they'd change for their own system, these are the parts to leave out:

- **The failing answer.** [`src/activities/research-activities.ts` lines 95–104](https://github.com/temporal-sa/openai-agents-sdk-deep-research-demo-typescript/blob/98f0b90df7f85a2864eb83b117f32d8e7487b45b/src/activities/research-activities.ts#L95-L104) fails the second-to-last answer on attempts 1 to 3, pausing 10 seconds before attempts 2 and 3 fail. A real `processClarification` would just store the answer.
- **Always asking questions.** [`src/agents/triage-agent.ts` lines 16–25](https://github.com/temporal-sa/openai-agents-sdk-deep-research-demo-typescript/blob/98f0b90df7f85a2864eb83b117f32d8e7487b45b/src/agents/triage-agent.ts#L16-L25) swaps in a prompt that always asks for clarification when `BYPASS_TRIAGE_AGENT=Y`. Without it, the triage agent skips questions for clear requests.
- **The start limit.** [`src/server/main.ts` lines 83–91](https://github.com/temporal-sa/openai-agents-sdk-deep-research-demo-typescript/blob/98f0b90df7f85a2864eb83b117f32d8e7487b45b/src/server/main.ts#L83-L91) keeps 5 starts per user per hour in memory, to cap OpenAI spend on a shared demo.
- **One process for everything, and files on local disk.** `src/app.ts` runs the API and the Worker together, and images and PDFs go to `ARTIFACT_ROOT` on that machine. A customer would scale Workers separately (`npm run dev:worker` runs one alone) and write artifacts to object storage.

## Reset and tear down

- **Between runs:** on the report page, click **Start new research**. After a cancelled or failed run, click **Start new research** in the panel.
- **To drop a run that's still going:** click **Cancel research**. The page otherwise resumes the last run each time it loads. A run left waiting for answers fails on its own after 30 minutes.
- **To stop:** cancel any run that's still going, then press `Ctrl-C` in the `npm run dev` terminal and the dev server. `Ctrl-C` lets running Activities finish before the process exits, so it can take as long as the slowest agent call in flight.
- **To clear generated files:** delete the `artifacts` folder. The app never deletes them.

## When something goes wrong

| What you see                                                                               | Likely cause                                                                                        | Fix                                                                                                       |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| "Research initialization failed: …", or the page shows **Research failed** at the start    | The triage or clarifying agent failed, most often a missing or invalid OpenAI key                   | Check `OPENAI_API_KEY` in `.env` and restart `npm run dev`                                                |
| **Research failed** after the questions, though the Temporal UI shows the run as Completed | The Workflow returns failures as a result; a research Activity used up its 5 attempts or 10 minutes | Open the run's result and the failed Activity in the Temporal UI for the error                            |
| "Saving your answer…" stays for about half a minute                                        | Expected on the second-to-last answer; that's the retry in beat 2                                   | Wait                                                                                                      |
| No questions appear; research starts straight away                                         | `BYPASS_TRIAGE_AGENT=Y` isn't set                                                                   | Add it to `.env` and restart                                                                              |
| The report has no image, and the page says "No generated image is available."              | Image generation failed, often because the OpenAI organization isn't verified for `gpt-image-1`     | Expected without access; the report is complete. Check the `generateResearchImage` Activity for the error |
| "Too many research requests. Please try again later."                                      | 5 starts in the last hour for this user (everyone shares one identity locally)                      | Wait, or restart the app to clear the in-memory count                                                     |
| `/api/ready` returns 503                                                                   | The app can't reach Temporal                                                                        | Start `temporal server start-dev`, or check the `TEMPORAL_*` variables                                    |
| "Connection interrupted. Retrying…"                                                        | `npm run dev` stopped                                                                               | Start it again; the page reconnects                                                                       |
| `Ctrl-C` doesn't exit right away                                                           | The Worker waits for running Activities to finish                                                   | Wait for the agent calls in flight to return                                                              |
| The page opens on "Welcome back — resuming your research session."                         | The browser remembered the last run                                                                 | Answer, click **Cancel research**, or clear the site's storage                                            |
| **View workflow** opens Temporal Cloud and you can't see the run                           | You don't have access to the demo's Namespace                                                       | Ask for access, or present the history from a local copy                                                  |

## Keeping this runbook current

The code links point at a fixed commit. When a linked file changes, update its link, line numbers, and snippet together. Before an event, list the linked files that have changed:

```sh
grep -oE 'blob/[0-9a-f]{40}/[^#)]+' RUNBOOK.md | sort -u | while IFS=/ read -r _ sha file; do
  git diff --quiet "$sha" HEAD -- "$file" || echo "changed since ${sha:0:7}: $file"
done
```
