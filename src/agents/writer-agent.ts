import { Agent } from "@openai/agents";
import { z } from "zod";

export const reportDataSchema = z.object({
  short_summary: z.string().describe("A two- or three-sentence summary."),
  markdown_report: z.string().describe("The complete report in Markdown."),
  follow_up_questions: z.array(z.string()),
});

const prompt = `You are a senior researcher tasked with writing a comprehensive,
in-depth report for a research query. You will receive the original query and
initial research summaries. First develop a detailed outline, then write the report.

Return an extensive, thoroughly detailed Markdown report of roughly 800-2000 words.
Include background context, multiple detailed sections and subsections, analysis,
specific examples and evidence where available, and thorough conclusions. Expand
key points with context and analysis rather than brief summaries. Cite factual claims
using Markdown links to the supplied source URLs. End with a Sources section that
lists only sources present in the supplied research results. Never invent a citation
or URL, and clearly label uncertainty or conflicting evidence.`;

export function newWriterAgent(): Agent<unknown, typeof reportDataSchema> {
  return new Agent({
    name: "WriterAgent",
    instructions: prompt,
    model: "o3-mini",
    outputType: reportDataSchema,
  });
}
