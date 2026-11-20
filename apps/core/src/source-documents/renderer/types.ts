export type SourceDocumentFormat = "pdf" | "docx";
export type SourceDocumentBlock =
  | { type: "paragraph"; text: string }
  | { type: "heading"; level: 1 | 2 | 3; text: string }
  | { type: "list"; ordered: boolean; items: string[] }
  | { type: "table"; headers: string[]; rows: string[][] };
export interface SourceDocumentRendererRequest {
  version: 1;
  format: SourceDocumentFormat;
  fileName: string;
  title: string;
  blocks: SourceDocumentBlock[];
}
export interface SourceDocumentRendererResult {
  version: 1;
  rendererVersion: string;
  fileName: string;
  contentType: "application/pdf" | "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  bytesBase64: string;
  sha256: string;
  sizeBytes: number;
}
export const MAX_INPUT_BYTES = 512 * 1024;
export const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
