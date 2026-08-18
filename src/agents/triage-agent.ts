import { Agent } from "@openai/agents";
import { z } from "zod";

export const triageDecisionSchema = z.object({
  needs_clarifications: z.boolean(),
  rationale: z.string(),
});

const normalPrompt = `Determine whether a research query needs clarification.

Clarification is needed when the query lacks important preferences or constraints,
is too broad, uses vague criteria such as "best", or is a location-based request
without specific criteria. It is not needed when the query has clear parameters,
is a focused factual lookup, or already contains enough context for research.`;

const bypassPrompt =
  "Always decide that the research query needs clarifying questions.";

export function newTriageAgent(): Agent<unknown, typeof triageDecisionSchema> {
  return new Agent({
    name: "Triage Agent",
    model: "gpt-4o-mini",
    instructions:
      process.env.BYPASS_TRIAGE_AGENT === "Y" ? bypassPrompt : normalPrompt,
    outputType: triageDecisionSchema,
  });
}
