import { Agent } from "@openai/agents";

const prompt = `Rewrite the user's query into detailed research instructions and
output only those instructions. Preserve every user preference, state unspecified
but necessary dimensions as open-ended, and do not invent details. Use first person.
Request useful tables and clear report headers where appropriate. Preserve the
requested language, prioritize primary sources, and explicitly specify the output
language.`;

export function newInstructionAgent(): Agent {
  return new Agent({
    name: "Research Instruction Agent",
    model: "gpt-4o-mini",
    instructions: prompt,
  });
}
