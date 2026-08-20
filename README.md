# Temporal OpenAI Deep Research Demo — TypeScript

A functional end-to-end TypeScript demo of durable, human-in-the-loop research
with the [OpenAI Agents SDK](https://openai.github.io/openai-agents-js/) and the
[Temporal TypeScript SDK](https://docs.temporal.io/develop/typescript). A user
submits a topic, answers clarifying questions, and receives a researched
Markdown report plus best-effort image and PDF artifacts.

This is a complete demonstration application, not a production research
service. It has a browser UI, API, Temporal worker, CLI, tests, a production
container, CI, and a `tmprl-demo.cloud` deployment manifest. The
[limitations](#production-limitations) section identifies the work still needed
for a public, multi-tenant service.

## What it demonstrates

- Durable orchestration that survives API or worker restarts
- Temporal Queries, Updates, Signals, timers, Activity retries, and
  cancellation
- Human clarification with a 30-minute durable wait
- A planned fan-out of 5–20 concurrent OpenAI web-search agents
- Structured agent outputs and a detailed Markdown synthesis
- Image generation in parallel with research and local PDF generation
- Graceful degradation when an individual search, the image, or the PDF fails
- A combined API/worker process suitable for a single-container demo

## Architecture

```text
Browser or CLI
      |
      v
Express API ---- start / query / update / signal ----> Temporal Workflow
                                                           |
                                                           +-- triage + clarification Activities
                                                           +-- search-planning Activity
                                                           +-- 5–20 parallel web-search Activities
                                                           +-- report-writing Activity
                                                           +-- image Activity (parallel, best effort)
                                                           +-- PDF Activity (best effort)
                                                                      |
                                                                      v
                                                        ARTIFACT_ROOT/images + reports
```

The workflow owns durable state and orchestration. OpenAI calls and filesystem
I/O run only in Activities, keeping workflow replay deterministic. `src/app.ts`
starts the HTTP server and worker together and shuts both down cleanly on
`SIGINT` or `SIGTERM`.

## Run from a clean clone

### Prerequisites

- Node.js 22 (the repository includes `.nvmrc`)
- The [Temporal CLI](https://docs.temporal.io/cli)
- An OpenAI API key with usable quota and access to the configured text, web
  search, and image APIs

Image generation with `gpt-image-1` may require OpenAI organization
verification. If image generation is unavailable, the report can still
complete without an image.

### Install and configure

```bash
git clone https://github.com/temporal-sa/openai-agents-sdk-deep-research-demo-typescript.git
cd openai-agents-sdk-deep-research-demo-typescript
nvm install
nvm use
npm ci
cp .env-sample .env
```

Edit `.env` and replace `your-openai-api-key`. The sample configuration uses a
local Temporal server, writes artifacts under `./artifacts`, serves on port
8234, and sets `AUTH_MODE=disabled` for local development.

### Start the demo

In one terminal, start Temporal:

```bash
temporal server start-dev
```

In a second terminal, start the combined API and worker:

```bash
npm run dev
```

Open <http://localhost:8234>. Temporal's local UI is at
<http://localhost:8233>.

Check the two probe endpoints:

```bash
curl -fsS http://localhost:8234/api/health
curl -fsS http://localhost:8234/api/ready
```

`/api/health` proves the process is alive. `/api/ready` also verifies a Temporal
connection and returns `503` until Temporal is reachable.

Every research run uses paid OpenAI API calls. Start with a narrow query while
validating credentials and quota.

### Other development modes

Run the worker and server separately when debugging their logs:

```bash
npm run dev:worker
npm run dev:server
```

Or use the interactive CLI while a worker is running:

```bash
npm run cli -- "Compare practical home energy-storage options in California"
```

Build and run the compiled combined application with:

```bash
npm run build
npm start
```

## Docker

The multi-stage image uses Node.js 22 on Debian bookworm-slim, installs only
production dependencies in its runtime stage, runs as the unprivileged `node`
user, and starts the combined app by default.

With the local Temporal dev server already running:

```bash
docker build -t openai-deep-research-ts .
docker run --rm \
  --name openai-deep-research-ts \
  --add-host=host.docker.internal:host-gateway \
  -p 8234:8234 \
  --env-file .env \
  -e TEMPORAL_ADDRESS=host.docker.internal:7233 \
  -v "$(pwd)/artifacts:/app/artifacts" \
  openai-deep-research-ts
```

The bind mount makes artifacts survive container replacement during local
testing. The container health check calls `/api/ready`, so it remains unhealthy
when Temporal is unavailable even if HTTP is listening.

## Workflow lifecycle, failure, and recovery

The browser starts a workflow and submits its query in one API request. Triage
either moves directly to research or produces clarification questions. Each
answer is submitted as a Temporal Update. Once all answers arrive, the planner
creates 5–20 searches, search Activities run concurrently, the writer
synthesizes the successful results, and the workflow returns the report.

The default Activity policy makes up to five attempts with exponential backoff.
For demonstration purposes, processing the second-to-last clarification answer
intentionally fails on its first three attempts and succeeds on its fourth.
This is expected and is visible in Temporal UI.

Failure behavior is deliberate:

- One failed web search is omitted; all searches failing makes the research
  stage fail.
- Image and PDF failures are logged and the Markdown report still completes.
- Initialization, clarification timeout, or core research failure becomes a
  terminal `failed` workflow state with a stage and message.
- A cancel request signals `endWorkflow`, cancels active research Activities,
  and produces a terminal `cancelled` result.

Temporal history is the source of truth. If the combined process stops, restart
it with the same Temporal namespace and task queue; the worker replays the
workflow and resumes outstanding work. The browser keeps the active workflow ID
in local storage, reconstructs answered clarifications from a status Query, and
resumes polling after a page reload. The workflow ID shown by the UI can also be
used for direct status queries. Generated files require separate persistence as
described under [Artifacts](#artifacts).

To cancel through the API in local auth-disabled mode:

```bash
curl -fsS -X POST \
  http://localhost:8234/api/cancel/WORKFLOW_ID
```

## HTTP API

| Method | Path                                     | Purpose                                                   |
| ------ | ---------------------------------------- | --------------------------------------------------------- |
| `GET`  | `/api/health`                            | Process liveness and non-secret runtime metadata          |
| `GET`  | `/api/ready`                             | Deadline-bounded Temporal connectivity check              |
| `POST` | `/api/start-research`                    | Start and initialize a workflow from `{ "query": "..." }` |
| `GET`  | `/api/status/:workflowId`                | Query durable interaction state                           |
| `POST` | `/api/answer/:workflowId/:questionIndex` | Submit `{ "answer": "..." }` as a Workflow Update         |
| `POST` | `/api/cancel/:workflowId`                | Signal cancellation                                       |
| `GET`  | `/api/result/:workflowId`                | Fetch a completed result                                  |
| `GET`  | `/artifacts/images/:file`                | Fetch a generated image                                   |
| `GET`  | `/artifacts/reports/:file`               | Fetch a generated PDF                                     |

Request bodies are JSON. The HTML entry points, workflow routes, and artifact
downloads are protected when ingress authentication is enabled; health,
readiness, and static browser assets remain public for probes and page loading.

## Authentication

`AUTH_MODE` accepts exactly two values:

- `disabled` is convenient for a trusted local machine and performs no user
  authentication. Never expose it on a public network.
- `temporal-ingress` requires the trusted `X-Temporal-Auth-Email` header and,
  when set, enforces `AUTH_ALLOWED_DOMAIN`. It is designed only for the managed
  authenticated `tmprl-demo.cloud` ingress, which strips client-supplied auth
  headers and injects its verified identity.

An invalid mode fails startup. If unset, the mode defaults to `disabled` outside
production and `temporal-ingress` when `NODE_ENV=production`. Do not put
`temporal-ingress` directly behind an untrusted proxy or expose its service
port publicly: a caller able to forge the trusted header could impersonate a
user.

`FRONTEND_ORIGINS` is a comma-separated CORS allowlist of exact `http://` or
`https://` origins (no wildcard, path, query, or fragment). The local sample
allows only `http://localhost:8234`; the deployment manifest allows only its
public HTTPS origin. When the setting is absent, cross-origin responses are not
enabled; ordinary same-origin requests continue to work.

The two HTML entry points are limited to 120 requests per minute per
authenticated email. Starting research is limited to five requests per hour
per authenticated email because each run launches several paid model calls.
Authentication runs before both limits, avoiding ambiguous reverse-proxy IP
addresses; in local `AUTH_MODE=disabled` use, requests intentionally share one
local-demo identity. Status polling, answers, cancellation, and result retrieval
do not consume the paid-operation limit. The in-memory counters are appropriate
for this single-replica demo; a multi-replica production deployment needs a
shared rate limit store.

## Temporal Cloud outside the demo registry

The API, worker, and CLI share these settings:

```dotenv
TEMPORAL_ADDRESS=your-namespace.tmprl.cloud:7233
TEMPORAL_NAMESPACE=your-namespace.account
TEMPORAL_API_KEY=your-temporal-api-key
TEMPORAL_TLS=true
TEMPORAL_TASK_QUEUE=research-queue
```

Use a secret manager rather than committing either API key. An API key implies
TLS in the application, but setting `TEMPORAL_TLS=true` documents the intended
connection explicitly.

## Models and cost controls

The current pipeline uses:

- `gpt-4o-mini` for triage, clarification, and image-concept generation
- `gpt-4o` to plan 5–20 searches
- the Agents SDK's configured/default model with its hosted web-search tool for
  each planned search
- `o3-mini` to synthesize the report
- `gpt-image-1` with low quality for one best-effort image
- PDFKit locally for PDF rendering

One run therefore makes several text-model calls, 5–20 web-search calls, and
normally one image call. Usage and cost vary with the query, output length,
search count, current model pricing, and retries. `BYPASS_TRIAGE_AGENT=Y` forces
the clarification path for demos; remove it to let triage skip unnecessary
questions. Consult current [OpenAI API pricing](https://openai.com/api/pricing/)
and set project budgets before sharing the app.

## Artifacts

Generated files use workflow/activity-derived names and are written atomically
beneath:

```text
ARTIFACT_ROOT/
  images/
  reports/
```

`ARTIFACT_ROOT` defaults to `./artifacts`. In a multi-replica environment, every
API and worker replica must mount the same persistent shared volume at that
path, or artifacts may be created on one replica and requested from another.
Temporal preserves workflow history, not filesystem contents. Configure an
external cleanup and retention policy because the application does not delete
old artifacts.

The supplied `tmprl-demo.cloud` manifest uses one replica, but the registry
currently offers no persistent-volume field, so its artifacts are ephemeral and
can disappear after a pod replacement.

## Quality checks

```bash
npm run format:check
npm run typecheck
npm test
npm run build
```

`npm run check` runs the same checks in sequence. GitHub Actions runs them from
a clean install and then builds the production container.

Tests cover deterministic model helpers, artifact path handling, workflow
states under Temporal's test environment, authentication boundaries, core HTTP
routes, and workflow bundling. Live OpenAI and Temporal Cloud calls are
intentionally not part of CI.

## Deploy to tmprl-demo.cloud

The repository includes the registry-ready resource and operator runbook:

- [`deploy/tmprl-demo-cloud/openai-deep-research-ts.yaml`](deploy/tmprl-demo-cloud/openai-deep-research-ts.yaml)
- [`deploy/tmprl-demo-cloud/README.md`](deploy/tmprl-demo-cloud/README.md)

The deployment uses one combined API/worker component, platform-managed
Temporal Cloud credentials, authenticated ingress, a project-scoped OpenAI
secret, and a `/api/ready` promotion check.

## Production limitations

Before treating this as a production or multi-tenant research service, address
at least the following:

- Move artifacts to durable object storage or a shared persistent volume, with
  lifecycle cleanup, backup, and malware/content controls.
- Add per-user workflow authorization, quotas, request throttling, abuse
  controls, audit logging, and stronger input/output policy enforcement.
- Replace the trusted-header auth boundary if deploying anywhere other than the
  managed ingress, and perform a security review of proxy configuration.
- Add observability, alerts, SLOs, cost ceilings, and operational runbooks for
  OpenAI and Temporal failures.
- Decide how to handle long-running workflow/version migrations and pin
  dependency/model versions according to an upgrade policy.
- Independently verify important claims and citations. Web retrieval and report
  synthesis are model-driven and can still omit context or make mistakes.
- Use external artifact storage before scaling beyond one replica.

## Project layout

- `src/agents/` — OpenAI agent definitions and structured output schemas
- `src/activities/` — research, image, clarification, and PDF Activities
- `src/workflows/` — deterministic durable orchestration
- `src/server/` — Express API, readiness, and authentication boundary
- `ui/` — static browser experience and TypeScript client
- `deploy/tmprl-demo-cloud/` — registry manifest and deployment runbook

## Acknowledgments and license

This is a TypeScript rewrite of Temporal's original Python demo. See
[ACKNOWLEDGMENTS.md](ACKNOWLEDGMENTS.md) for provenance.

MIT — see [LICENSE](LICENSE).
