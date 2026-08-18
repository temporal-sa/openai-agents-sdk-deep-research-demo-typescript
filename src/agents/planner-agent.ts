import { Agent } from "@openai/agents";
import { z } from "zod";

export const webSearchItemSchema = z.object({
  reason: z.string().describe("Why this search is important to the query."),
  query: z.string().describe("The search term to use."),
});

export const webSearchPlanSchema = z.object({
  searches: z
    .array(webSearchItemSchema)
    .min(5)
    .max(20)
    .describe("Searches that will best answer the query."),
});

const prompt =
  "You are a helpful research assistant. Given a query, come up with a set " +
  "of web searches to perform to best answer it. Output between 5 and 20 searches.";

export function newPlannerAgent(): Agent<unknown, typeof webSearchPlanSchema> {
  return new Agent({
    name: "PlannerAgent",
    instructions: prompt,
    model: "gpt-4o",
    outputType: webSearchPlanSchema,
  });
}
