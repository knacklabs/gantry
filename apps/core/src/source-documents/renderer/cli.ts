import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { renderDocument } from "./render.js";
import { MAX_INPUT_BYTES } from "./types.js";
import { parseRendererRequest } from "./validation.js";

export async function runRenderer(): Promise<void> {
  try {
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of process.stdin) {
      length += chunk.length;
      if (length > MAX_INPUT_BYTES) throw new Error("Document input exceeds byte limit.");
      chunks.push(chunk);
    }
    const result = await renderDocument(parseRendererRequest(Buffer.concat(chunks, length)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write('{"error":"DOCUMENT_RENDER_FAILED"}\n');
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void runRenderer();
