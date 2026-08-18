import { Agent } from "@openai/agents";
import { z } from "zod";

export const imageConceptSchema = z.object({
  image_description: z
    .string()
    .describe("A specific two-sentence image-generation prompt."),
  notes: z
    .string()
    .describe("Notes about the visual concept and design choices."),
});

const prompt = `You are a visual content specialist for research reports. Analyze
the topic and create a professional two-sentence image description. Prefer an
illustrative, informative scene or diagram; avoid screenshots and text-heavy images.
Make the description concrete and appropriate to the research domain.`;

export function newImagegenAgent(): Agent<unknown, typeof imageConceptSchema> {
  return new Agent({
    name: "ImageGenAgent",
    instructions: prompt,
    model: "gpt-4o-mini",
    outputType: imageConceptSchema,
  });
}
