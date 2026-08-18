import { Agent, webSearchTool } from "@openai/agents";
import { z } from "zod";

export const searchSummarySchema = z.object({
  summary: z.string().describe("A concise evidence summary under 250 words."),
  sources: z
    .array(
      z.object({
        title: z.string().describe("The source page or document title."),
        url: z
          .string()
          .describe("The exact source URL returned by web search."),
      }),
    )
    .min(1)
    .describe("Sources that directly support the summary."),
});

const instructions = `You are a careful research assistant. Use web search for the
given search term, prioritize primary and authoritative sources, and return a concise
evidence summary under 250 words. Include the exact title and URL for every source
you relied on. Never invent, shorten, or guess a URL.`;

export function newSearchAgent(): Agent<unknown, typeof searchSummarySchema> {
  return new Agent({
    name: "Search agent",
    instructions,
    tools: [webSearchTool()],
    modelSettings: { toolChoice: "required" },
    outputType: searchSummarySchema,
  });
}
