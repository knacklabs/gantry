import { createHash } from "node:crypto";
import { renderDocx } from "./docx.js";
import { parseRendererRequest } from "./validation.js";
import { MAX_OUTPUT_BYTES, type SourceDocumentRendererRequest, type SourceDocumentRendererResult } from "./types.js";

export async function renderDocument(input: SourceDocumentRendererRequest): Promise<SourceDocumentRendererResult> {
  const request = parseRendererRequest(Buffer.from(JSON.stringify(input)));
  const bytes = request.format === "docx" ? await renderDocx(request) : await (await import("./pdf.js")).renderPdf(request);
  if (bytes.length > MAX_OUTPUT_BYTES) throw new Error("Rendered document exceeds output limit.");
  return { version: 1, rendererVersion: "source-document-1.0.0", fileName: request.fileName,
    contentType: request.format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    bytesBase64: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length };
}
