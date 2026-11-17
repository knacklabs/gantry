import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseRendererRequest } from './renderer/validation.js';
import {
  MAX_OUTPUT_BYTES,
  type SourceDocumentRendererRequest,
  type SourceDocumentRendererResult,
} from './renderer/types.js';
const MAX_STDOUT_BYTES = 12 * 1024 * 1024;
/** Runs only the packaged renderer. Text input cannot choose executable, fonts, or filesystem paths. */
export async function launchSourceDocumentRenderer(
  request: SourceDocumentRendererRequest,
  options: { deadlineAtMs: number; signal?: AbortSignal; entrypoint?: string },
): Promise<{ result: SourceDocumentRendererResult; bytes: Buffer }> {
  const input = Buffer.from(JSON.stringify(request));
  parseRendererRequest(input);
  const budget = Math.min(30000, options.deadlineAtMs - Date.now());
  if (budget <= 0 || options.signal?.aborted)
    throw new Error('Document rendering execution budget expired');
  const entrypoint =
    options.entrypoint ??
    fileURLToPath(new URL('./renderer/cli.js', import.meta.url));
  const stdout = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(process.execPath, [entrypoint], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      env: {
        LANG: 'C.UTF-8',
        ...(process.env.GANTRY_DOCUMENT_FONT_DIR
          ? { GANTRY_DOCUMENT_FONT_DIR: process.env.GANTRY_DOCUMENT_FONT_DIR }
          : {}),
      },
    });
    let failed = false;
    let length = 0;
    let stderrLength = 0;
    const chunks: Buffer[] = [];
    let hardKill: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      failed = true;
      child.kill('SIGTERM');
      hardKill ??= setTimeout(() => child.kill('SIGKILL'), 100);
    };
    const timer = setTimeout(stop, budget);
    options.signal?.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > MAX_STDOUT_BYTES) stop();
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrLength += chunk.length;
      if (stderrLength > 4096) stop();
    });
    child.stdin.on('error', () => {
      failed = true;
    });
    child.on('error', () => {
      failed = true;
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (hardKill) clearTimeout(hardKill);
      options.signal?.removeEventListener('abort', stop);
      if (failed || code !== 0) reject(new Error('Document rendering failed'));
      else resolve(Buffer.concat(chunks, length));
    });
    child.stdin.end(input);
  });
  try {
    const value = JSON.parse(
      stdout.toString('utf8'),
    ) as SourceDocumentRendererResult;
    const keys = [
      'version',
      'rendererVersion',
      'fileName',
      'contentType',
      'bytesBase64',
      'sha256',
      'sizeBytes',
    ];
    if (
      !value ||
      Object.keys(value).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(value, key)) ||
      value.version !== 1 ||
      typeof value.rendererVersion !== 'string' ||
      value.rendererVersion.length > 100 ||
      value.fileName !== request.fileName ||
      value.contentType !==
        (request.format === 'pdf'
          ? 'application/pdf'
          : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') ||
      typeof value.bytesBase64 !== 'string' ||
      !Number.isSafeInteger(value.sizeBytes) ||
      value.sizeBytes <= 0 ||
      value.sizeBytes > MAX_OUTPUT_BYTES ||
      !/^[a-f0-9]{64}$/.test(value.sha256)
    )
      throw new Error();
    const bytes = Buffer.from(value.bytesBase64, 'base64');
    if (
      bytes.toString('base64') !== value.bytesBase64 ||
      bytes.length !== value.sizeBytes ||
      createHash('sha256').update(bytes).digest('hex') !== value.sha256 ||
      !(request.format === 'pdf'
        ? bytes.subarray(0, 5).toString() === '%PDF-'
        : bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])))
    )
      throw new Error();
    if (options.signal?.aborted || Date.now() >= options.deadlineAtMs)
      throw new Error();
    return { result: value, bytes };
  } catch {
    throw new Error('Document rendering failed');
  }
}
