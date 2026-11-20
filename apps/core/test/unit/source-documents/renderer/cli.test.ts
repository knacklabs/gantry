import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
const entry = fileURLToPath(new URL("../../../../src/source-documents/renderer/cli.ts", import.meta.url));
async function execute(input: Buffer) {
  const child = spawn(process.execPath, ["--import", "tsx", entry], { stdio: ["pipe", "pipe", "pipe"] });
  const stdout: Buffer[] = []; const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk)); child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.stdin.on("error", () => {}); child.stdin.end(input);
  const code = await new Promise((done, reject) => { child.once("exit", done); child.once("error", reject); });
  return { code, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
}
describe("JSON-only isolated renderer process", () => {
  it("returns one JSON response with real bytes and no filesystem path", async () => {
    const result = await execute(Buffer.from(JSON.stringify({ version: 1, format: "pdf", fileName: "Tender.pdf", title: "Tender", blocks: [{ type: "paragraph", text: "Readable tender" }] })));
    expect(result.code).toBe(0); expect(result.stderr).toBe("");
    const output = JSON.parse(result.stdout); expect(Buffer.from(output.bytesBase64, "base64").subarray(0, 5).toString()).toBe("%PDF-");
    expect(Object.keys(output).sort()).toEqual(["version", "rendererVersion", "fileName", "contentType", "bytesBase64", "sha256", "sizeBytes"].sort());
  }, 30000);
  it.each([Buffer.alloc(512 * 1024 + 1, 32), Buffer.from('{"script":"execute"}')])("fails excess or invalid input without stdout artifacts or internal error details", async (input) => {
    const result = await execute(input); expect(result.code).toBe(1); expect(result.stdout).toBe(""); expect(JSON.parse(result.stderr)).toEqual({ error: "DOCUMENT_RENDER_FAILED" });
  });
});
