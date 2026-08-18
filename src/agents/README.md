# Research agents

Each file defines one OpenAI agent and, where applicable, a Zod schema for its
structured output.

```text
Query ─► Triage ─► Clarifying questions (when needed) ─► Instructions
                                                          │
                                                          └─► Planner
                                                               ├─► Search agents (parallel) ─► Writer
                                                               └─► Image concept
```

- `triage-agent.ts` decides whether more context is needed.
- `clarifying-agent.ts` creates up to three focused questions.
- `instruction-agent.ts` turns the enriched request into focused research instructions.
- `planner-agent.ts` returns 5–20 typed web searches.
- `search-agent.ts` uses OpenAI's hosted web-search tool and returns exact source URLs.
- `writer-agent.ts` returns the typed, source-linked report payload.
- `imagegen-agent.ts` produces the image concept consumed by the image activity.

PDF styling is deterministic and handled by an Activity rather than another model
call.

Agent runs occur only inside Activities. They must not be imported into a
Temporal Workflow module because model calls are nondeterministic.
