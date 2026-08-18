# Temporal Research UI developer guide

## Build and run

The browser source lives in `ui/src/ts`. Build the three browser bundles with:

```bash
npm run build:ui
```

The development server automatically builds the UI before it starts:

```bash
npm run dev:server
```

For the complete local flow, start a Temporal development server and the worker
as described in the root README. `AUTH_MODE` defaults to `disabled` outside
production; setting it explicitly is clearer:

```bash
AUTH_MODE=disabled npm run dev:server
```

## Authentication

The browser does not implement its own login flow and does not attach identity
headers.

- `AUTH_MODE=disabled` performs no authentication and is only for trusted local
  development.
- `AUTH_MODE=temporal-ingress` trusts the verified
  `X-Temporal-Auth-Email` header injected by the managed tmprl-demo.cloud
  ingress. Do not expose this mode behind an untrusted proxy or directly to the
  public internet.

The API, generated image, and generated PDF routes use the same server-side auth
policy. Health and readiness probes remain public.

## Browser session behavior

The research page sends the initial query through a single
`POST /api/start-research` call. It stores the active workflow ID and Temporal UI
URL in `localStorage`, so reopening the page resumes the durable interaction via
`GET /api/status/:workflowId`.

Only one polling loop is active at a time. Polling stops while an answer or
cancellation is submitted and stops permanently for `completed`, `failed`, and
`cancelled` states.

The result page accepts the workflow ID in `?wf=...`, fetches the authoritative
result when needed, and caches the last fetched result in `sessionStorage`.
Markdown is parsed with `marked` and sanitized with DOMPurify before insertion
into the document.

## API contract

### `POST /api/start-research`

Accepts the initial query and starts plus initializes the workflow in one
request:

```json
{
  "query": "Compare heat-pump options for a small office"
}
```

The response contains the workflow identity, Temporal UI URL, and current
interaction state:

```json
{
  "workflow_id": "interactive-research-abc123",
  "temporal_ui_url": "http://localhost:8233/namespaces/default/workflows/interactive-research-abc123",
  "status": "awaiting_clarifications",
  "original_query": "Compare heat-pump options for a small office",
  "clarification_questions": ["What climate should I assume?"],
  "clarification_responses": {},
  "current_question": "What climate should I assume?",
  "current_question_index": 0,
  "total_questions": 1,
  "research_completed": false,
  "error_message": null,
  "failure_stage": null
}
```

### `GET /api/status/:workflowId`

Returns the same serialized interaction fields. Status values are `pending`,
`initializing`, `awaiting_clarifications`, `collecting_answers`, `researching`,
`completed`, `failed`, and `cancelled`.

### `POST /api/answer/:workflowId/:questionIndex`

Accepts:

```json
{
  "answer": "A cool, wet coastal climate"
}
```

The question index prevents a stale browser tab from answering the wrong
question. The response is the updated serialized interaction.

### `POST /api/cancel/:workflowId`

Signals cancellation and returns the updated serialized interaction. The browser
continues polling until it observes a terminal state if cancellation is not yet
visible.

### `GET /api/result/:workflowId`

Returns a terminal result for completed, failed, or cancelled research:

```json
{
  "workflow_id": "interactive-research-abc123",
  "status": "completed",
  "error_message": null,
  "markdown_report": "# Research Report",
  "short_summary": "Brief summary",
  "follow_up_questions": ["Which vendors should be shortlisted?"],
  "image_file_path": "/artifacts/images/research-image.png",
  "pdf_file_path": "/artifacts/reports/research-report.pdf"
}
```

Image and PDF paths are nullable. The result page hides unavailable artifacts
and always labels Markdown and PDF downloads separately.

## Source layout

```text
ui/
├── dist/js/           # generated browser bundles
├── public/            # UI icons
├── src/css/           # shared styles
├── src/ts/            # API client and page controllers
├── index.html         # resumable research chat
└── success.html       # sanitized report result
```

The backend lives in `src/server`, and workflow message types live in
`src/shared/types.ts`.
