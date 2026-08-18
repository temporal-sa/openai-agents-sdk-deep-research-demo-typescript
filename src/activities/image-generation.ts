import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import OpenAI from "openai";
import sharp from "sharp";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";

import { run } from "@openai/agents";
import { newImagegenAgent } from "../agents/imagegen-agent.js";
import {
  artifactDirectory,
  artifactPath,
  artifactPublicPath,
} from "../artifacts.js";
import type {
  ImageGenerationResult,
  ImageGenData,
  ImageStylingOptions,
} from "../shared/types.js";

const nonRetryableIndicators = [
  "organization must be verified",
  "403",
  "invalid_request_error",
  "insufficient_quota",
  "invalid_api_key",
  "serialization",
];

function imageFilename(extension: string): string {
  const info = Context.current().info;
  const identity = `${info.workflowExecution?.workflowId ?? "standalone"}:${info.activityId}`;
  const digest = createHash("sha256")
    .update(identity)
    .digest("hex")
    .slice(0, 20);
  return `research-image-${digest}.${extension}`;
}

export async function generateImage(input: {
  prompt: string;
  stylingOptions?: ImageStylingOptions;
}): Promise<ImageGenerationResult> {
  const options = {
    size: input.stylingOptions?.size ?? "1024x1024",
    outputFormat: input.stylingOptions?.output_format ?? "png",
    outputCompression: input.stylingOptions?.output_compression ?? undefined,
    resizeWidth: input.stylingOptions?.resize_width ?? 600,
  } as const;

  try {
    const client = new OpenAI();
    const response = await client.images.generate({
      model: "gpt-image-1",
      prompt: input.prompt,
      quality: "low",
      size: options.size,
      output_format: options.outputFormat,
      ...(options.outputCompression === undefined
        ? {}
        : { output_compression: options.outputCompression }),
    });

    const encoded = response.data?.[0]?.b64_json;
    if (!encoded) throw new Error("No base64 image data returned by OpenAI");

    let bytes: Buffer<ArrayBufferLike> = Buffer.from(encoded, "base64");
    if (options.resizeWidth) {
      const pipeline = sharp(bytes).resize({
        width: options.resizeWidth,
        withoutEnlargement: true,
      });
      if (options.outputFormat === "jpeg")
        bytes = await pipeline.jpeg().toBuffer();
      else if (options.outputFormat === "webp")
        bytes = await pipeline.webp().toBuffer();
      else bytes = await pipeline.png().toBuffer();
    }

    const directory = artifactDirectory("images");
    await mkdir(directory, { recursive: true });
    const filename = imageFilename(options.outputFormat);
    const absolutePath = artifactPath("images", filename);
    const temporaryPath = `${absolutePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, bytes);
    await rename(temporaryPath, absolutePath);
    const relativePath = artifactPublicPath("images", filename);

    Context.current().log.info("Generated research image", {
      bytes: bytes.length,
      path: relativePath,
    });
    return {
      image_file_path: relativePath,
      mime_type: `image/${options.outputFormat}`,
      success: true,
      error_message: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    Context.current().log.error("Image generation failed", { error: message });
    if (
      nonRetryableIndicators.some((indicator) =>
        message.toLowerCase().includes(indicator.toLowerCase()),
      )
    ) {
      throw ApplicationFailure.nonRetryable(
        `Image generation failed: ${message}`,
        "ImageGenerationError",
      );
    }
    throw error instanceof Error ? error : new Error(message);
  }
}

export async function generateResearchImage(
  query: string,
): Promise<ImageGenData> {
  const concept = await run(
    newImagegenAgent(),
    `Create an image concept for this research topic: ${query}`,
  );
  if (!concept.finalOutput) {
    throw new Error("Image concept agent did not produce an output");
  }

  const generated = await generateImage({
    prompt: concept.finalOutput.image_description,
  });
  return {
    success: true,
    image_description: concept.finalOutput.image_description,
    image_file_path: generated.image_file_path,
    notes: concept.finalOutput.notes,
    error_message: null,
  };
}
