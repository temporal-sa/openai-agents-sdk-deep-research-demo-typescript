import { Agent } from "@openai/agents";
import { z } from "zod";

export const clarificationsSchema = z.object({
  questions: z
    .array(z.string())
    .min(1)
    .max(3)
    .describe("Concise questions needed to focus the research."),
});

const prompt = `Ask three concise clarifying questions that gather the information
needed to carry out the user's research. Do not ask for unnecessary information or
details already provided. Maintain a friendly, non-condescending tone and follow
safety guidelines. If the user did not ask for research, ask what they want researched.`;

export function newClarifyingAgent(): Agent<
  unknown,
  typeof clarificationsSchema
> {
  return new Agent({
    name: "Clarifying Questions Agent",
    model: "gpt-4o-mini",
    instructions: prompt,
    outputType: clarificationsSchema,
  });
}
