import { MAX_INPUT_BYTES, type SourceDocumentRendererRequest } from "./types.js";

function requireValue(condition: unknown): asserts condition {
  if (!condition) throw new Error("Invalid document renderer request.");
}
function object(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  requireValue(value && typeof value === "object" && !Array.isArray(value));
  requireValue(Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)));
}

/** Accepts only the bounded version-one text contract; no renderer instructions come from input. */
export function parseRendererRequest(bytes: Uint8Array): SourceDocumentRendererRequest {
  requireValue(bytes.byteLength <= MAX_INPUT_BYTES);
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  object(value, ["version", "format", "fileName", "title", "blocks"]);
  requireValue(value.version === 1 && ["pdf", "docx"].includes(String(value.format)));
  let characters = 0;
  const text = (input: unknown, maximum = 100000): void => {
    requireValue(typeof input === "string" && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input));
    let length = 0;
    for (const character of input) {
      const point = character.codePointAt(0)!;
      requireValue(point < 0xd800 || point > 0xdfff);
      length++;
    }
    requireValue(length <= maximum); characters += length; requireValue(characters <= 100000);
  };
  requireValue(typeof value.fileName === "string" && value.fileName.length > 0 && value.fileName.length <= 128);
  requireValue(!/[\\/:*?"<>|\u0000-\u001f\u007f]/u.test(value.fileName) && !value.fileName.startsWith(".") && !value.fileName.endsWith(" "));
  requireValue(!/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value.fileName));
  requireValue(value.fileName.endsWith(`.${value.format}`));
  text(value.title, 200);
  requireValue(Array.isArray(value.blocks) && value.blocks.length >= 1 && value.blocks.length <= 200);
  for (const block of value.blocks) {
    requireValue(block && typeof block === "object" && !Array.isArray(block));
    switch (block.type) {
      case "paragraph": object(block, ["type", "text"]); text(block.text); break;
      case "heading": object(block, ["type", "level", "text"]); requireValue([1, 2, 3].includes(block.level as number)); text(block.text); break;
      case "list":
        object(block, ["type", "ordered", "items"]); requireValue(typeof block.ordered === "boolean");
        requireValue(Array.isArray(block.items) && block.items.length >= 1 && block.items.length <= 100); block.items.forEach((item) => text(item)); break;
      case "table":
        object(block, ["type", "headers", "rows"]);
        requireValue(Array.isArray(block.headers) && block.headers.length >= 1 && block.headers.length <= 20); block.headers.forEach((item) => text(item));
        requireValue(Array.isArray(block.rows) && block.rows.length <= 200);
        for (const row of block.rows) { requireValue(Array.isArray(row) && row.length === block.headers.length); row.forEach((item) => text(item)); } break;
      default: throw new Error("Unsupported document block.");
    }
  }
  return value as unknown as SourceDocumentRendererRequest;
}
