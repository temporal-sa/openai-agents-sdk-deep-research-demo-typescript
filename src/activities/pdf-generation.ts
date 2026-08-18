import { Context } from "@temporalio/activity";
import PDFDocument from "pdfkit";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, rename } from "node:fs/promises";

import {
  artifactDirectory,
  artifactPath,
  artifactPublicPath,
  resolveArtifactPublicPath,
} from "../artifacts.js";
import type {
  PDFGenerationInput,
  PDFGenerationResult,
} from "../shared/types.js";

function renderMarkdown(
  doc: PDFKit.PDFDocument,
  markdown: string,
  fontSize: number,
  primaryColor: string,
): void {
  let inCodeBlock = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      if (!inCodeBlock) doc.moveDown(0.5);
      continue;
    }
    if (inCodeBlock) {
      doc
        .font("Courier")
        .fontSize(Math.max(8, fontSize - 2))
        .fillColor("#263238")
        .text(line || " ", { indent: 12 });
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      doc
        .moveDown(level === 1 ? 1 : 0.7)
        .font("Helvetica-Bold")
        .fontSize(fontSize + (4 - level) * 3)
        .fillColor(primaryColor)
        .text(heading[2] ?? "")
        .moveDown(0.35);
      continue;
    }

    const bullet = /^\s*[-*+]\s+(.+)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (bullet || numbered) {
      doc
        .font("Helvetica")
        .fontSize(fontSize)
        .fillColor("#333333")
        .text(bullet?.[1] ?? numbered?.[1] ?? "", {
          bulletRadius: 2,
          indent: 16,
          paragraphGap: 4,
        });
      continue;
    }

    if (line.startsWith("> ")) {
      doc
        .font("Helvetica-Oblique")
        .fontSize(fontSize)
        .fillColor("#555555")
        .text(line.slice(2), { indent: 16, paragraphGap: 8 });
      continue;
    }

    if (line.trim()) {
      doc
        .font("Helvetica")
        .fontSize(fontSize)
        .fillColor("#333333")
        .text(line.replaceAll(/\*\*|__/g, ""), {
          align: "justify",
          lineGap: 3,
          paragraphGap: 7,
        });
    } else {
      doc.moveDown(0.45);
    }
  }
}

export async function generatePdf(
  input: PDFGenerationInput,
): Promise<PDFGenerationResult> {
  const title = input.title ?? "Research Report";
  const fontSize = input.styling_options?.font_size ?? 11;
  const primaryColor = input.styling_options?.primary_color ?? "#2c3e50";

  try {
    const directory = artifactDirectory("reports");
    await mkdir(directory, { recursive: true });
    const info = Context.current().info;
    const identity = `${info.workflowExecution?.workflowId ?? "standalone"}:${info.activityId}`;
    const digest = createHash("sha256")
      .update(identity)
      .digest("hex")
      .slice(0, 20);
    const filename = `research-report-${digest}.pdf`;
    const relativePath = artifactPublicPath("reports", filename);
    const absolutePath = artifactPath("reports", filename);
    const temporaryPath = `${absolutePath}.${randomUUID()}.tmp`;

    await new Promise<void>((resolve, reject) => {
      const doc = new PDFDocument({
        size: "LETTER",
        margins: { top: 54, right: 54, bottom: 54, left: 54 },
        info: { Title: title },
      });
      const stream = createWriteStream(temporaryPath);
      stream.on("finish", resolve);
      stream.on("error", reject);
      doc.pipe(stream);

      doc
        .font("Helvetica-Bold")
        .fontSize(28)
        .fillColor(primaryColor)
        .text(title)
        .moveDown(0.7);

      if (input.image_file_path) {
        const imagePath = resolveArtifactPublicPath(input.image_file_path);
        doc.image(imagePath, { fit: [480, 280], align: "center" }).moveDown(1);
      }

      renderMarkdown(doc, input.markdown_content, fontSize, primaryColor);
      doc.end();
    });

    await rename(temporaryPath, absolutePath);
    await access(absolutePath);
    Context.current().log.info("Generated PDF report", { path: relativePath });
    return { pdf_file_path: relativePath, success: true, error_message: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    Context.current().log.error("PDF generation failed", { error: message });
    throw error instanceof Error ? error : new Error(message);
  }
}
