import fs from 'node:fs';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { BrowserIpcAction } from '@myclaw/contracts';

import {
  BROWSER_ACTION_TIMEOUT_MS,
  createBrowserActionMcpServerConfig,
  type BrowserActionMcpServerConfig,
} from './action-mcp.js';
import { applyAgentEgressNoProxyEnv } from '../../shared/no-proxy.js';

const BROWSER_MCP_TIMEOUT_MS = 60_000;
const BROWSER_MCP_IDLE_MS = 120_000;
const MIN_BROWSER_ACTION_TIMEOUT_MS = 1_000;
const MAX_BROWSER_ACTION_TIMEOUT_MS = 120_000;
const INLINE_SNAPSHOT_COMPACTION_BYTES = 32 * 1024;
const SNAPSHOT_PREVIEW_BYTES = 4 * 1024;
const BROWSER_FILE_OUTPUT_TOOLS = new Set<BrowserIpcAction>([
  'browser_take_screenshot',
  'browser_snapshot',
  'browser_console_messages',
  'browser_network_requests',
  'browser_evaluate',
]);

interface BrowserToolSession {
  running?: boolean;
  cdpReady?: boolean;
  port?: number;
  profileName?: string;
}

export async function callBrowserTool(input: {
  toolName: BrowserIpcAction;
  arguments: Record<string, unknown>;
  session: BrowserToolSession;
  fileAccessRoot: string;
  timeoutMs?: number;
  createBackendConfig?: (
    cdpEndpoint: string,
    options: { outputDir?: string },
  ) => BrowserActionMcpServerConfig;
}): Promise<unknown> {
  const args = normalizeBrowserFilePayload(input.arguments, {
    fileAccessRoot: input.fileAccessRoot,
  });
  if (
    !input.session.running ||
    !input.session.cdpReady ||
    !input.session.port
  ) {
    throw new Error('Browser is not ready for actions.');
  }

  const cdpEndpoint = `http://127.0.0.1:${input.session.port}`;
  const outputDir = ensureBrowserArtifactRoot(input.fileAccessRoot);
  const config = (
    input.createBackendConfig ?? createBrowserActionMcpServerConfig
  )(cdpEndpoint, { outputDir });
  const backend = await getBackendClient({
    key: backendKey(input.session.profileName, cdpEndpoint, outputDir),
    config,
  });

  try {
    const result = await backend.client.callTool(
      { name: input.toolName, arguments: args },
      undefined,
      { timeout: browserActionTimeoutMs(input.timeoutMs) },
    );
    return normalizeBrowserToolResult(input.toolName, args, result, {
      artifactRoot: outputDir,
    });
  } catch (err) {
    await closeCachedBackend(backend.key);
    throw new Error(formatBackendError(input.toolName, err));
  } finally {
    scheduleBackendIdleClose(backend.key);
  }
}

export function normalizeBrowserToolResult(
  toolName: BrowserIpcAction,
  args: Record<string, unknown>,
  result: unknown,
  options: { artifactRoot?: string } = {},
): unknown {
  const sanitized = sanitizeInternalChromeTargets(result);
  const filename = stringValue(args.filename);
  if (!filename || !BROWSER_FILE_OUTPUT_TOOLS.has(toolName)) {
    if (toolName === 'browser_snapshot' && options.artifactRoot) {
      return compactLargeBrowserSnapshot(sanitized, options.artifactRoot);
    }
    return sanitized;
  }
  const saved: { wroteFile: boolean; mimeType?: string } =
    toolName === 'browser_take_screenshot'
      ? persistInlineScreenshot(filename, sanitized)
      : { wroteFile: false };
  const stat = browserOutputFileStat(filename);
  if (!saved.wroteFile && !stat) return sanitized;
  return browserFileReferenceResult(filename, stat, saved.mimeType);
}

function compactLargeBrowserSnapshot(result: unknown, artifactRoot: string) {
  const text = browserResultText(result);
  if (Buffer.byteLength(text, 'utf8') <= INLINE_SNAPSHOT_COMPACTION_BYTES) {
    return result;
  }
  const root = ensureBrowserArtifactRoot(artifactRoot);
  const filename = path.join(root, `snapshot-${Date.now()}.txt`);
  fs.writeFileSync(filename, text, 'utf8');
  const stat = fs.statSync(filename);
  const preview = truncateUtf8(text, SNAPSHOT_PREVIEW_BYTES);
  return {
    content: [
      {
        type: 'text',
        text: `Saved snapshot to ${filename}\n\nPreview:\n${preview}`,
      },
    ],
    file: {
      path: filename,
      mimeType: 'text/plain',
      sizeBytes: stat.size,
    },
    preview,
  };
}

function browserResultText(result: unknown): string {
  if (!result || typeof result !== 'object') return String(result ?? '');
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return JSON.stringify(result);
  return content
    .map((item) => {
      if (!item || typeof item !== 'object') return '';
      const row = item as Record<string, unknown>;
      return row.type === 'text' && typeof row.text === 'string'
        ? row.text
        : '';
    })
    .filter(Boolean)
    .join('\n');
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let output = '';
  for (const char of value) {
    const next = output + char;
    if (Buffer.byteLength(next, 'utf8') > maxBytes) break;
    output = next;
  }
  return output;
}

function browserFileReferenceResult(
  filename: string,
  stat?: fs.Stats,
  mimeType?: string,
): Record<string, unknown> {
  return {
    content: [
      {
        type: 'text',
        text: `Saved to ${filename}`,
      },
    ],
    file: {
      path: filename,
      ...(mimeType ? { mimeType } : {}),
      ...(stat?.isFile() ? { sizeBytes: stat.size } : {}),
    },
  };
}

function browserOutputFileStat(filename: string): fs.Stats | undefined {
  if (!fs.existsSync(filename)) return undefined;
  const stat = fs.statSync(filename);
  return stat.isFile() ? stat : undefined;
}

export function sanitizeBrowserTabsResult(result: unknown): unknown {
  return sanitizeInternalChromeTargets(result);
}

function sanitizeInternalChromeTargets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value
      .filter((item) => !isInternalChromeTargetRecord(item))
      .map(sanitizeInternalChromeTargets);
  }
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if (isInternalChromeTargetRecord(record)) return undefined;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (key === 'content' && Array.isArray(item)) {
      next[key] = sanitizeBrowserContentBlocks(item);
      continue;
    }
    const sanitized = sanitizeInternalChromeTargets(item);
    if (sanitized !== undefined) next[key] = sanitized;
  }
  return next;
}

function sanitizeBrowserContentBlocks(blocks: unknown[]): unknown[] {
  return blocks
    .map((block) => {
      if (!block || typeof block !== 'object') return block;
      const row = block as Record<string, unknown>;
      if (row.type !== 'text' || typeof row.text !== 'string') return block;
      return {
        ...row,
        text: row.text
          .split('\n')
          .filter((line) => !isInternalChromeTargetText(line))
          .join('\n'),
      };
    })
    .filter((block) => {
      if (!block || typeof block !== 'object') return true;
      const row = block as Record<string, unknown>;
      return row.type !== 'text' || row.text !== '';
    });
}

function isInternalChromeTargetRecord(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return [row.url, row.title].some(
    (item) => typeof item === 'string' && isInternalChromeTargetText(item),
  );
}

function isInternalChromeTargetText(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized.includes('chrome://new-tab-page') ||
    normalized.includes('chrome://omnibox-popup')
  );
}

function persistInlineScreenshot(
  filename: string,
  result: unknown,
): { wroteFile: boolean; mimeType?: string } {
  const image = firstInlineImage(result);
  if (!image) return { wroteFile: false };
  fs.writeFileSync(filename, Buffer.from(image.data, 'base64'));
  return { wroteFile: true, mimeType: image.mimeType };
}

function firstInlineImage(
  result: unknown,
): { data: string; mimeType?: string } | null {
  if (!result || typeof result !== 'object') return null;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return null;
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    if (row.type !== 'image' || typeof row.data !== 'string') continue;
    return {
      data: row.data,
      mimeType: typeof row.mimeType === 'string' ? row.mimeType : undefined,
    };
  }
  return null;
}

interface CachedBackend {
  key: string;
  client: Client;
  transport: StdioClientTransport;
  idleTimer?: ReturnType<typeof setTimeout>;
}

interface PendingBackend {
  promise: Promise<CachedBackend>;
  closeOnResolve: boolean;
}

const cachedBackends = new Map<string, CachedBackend>();
const pendingBackends = new Map<string, PendingBackend>();

function backendKey(
  profileName: string | undefined,
  cdpEndpoint: string,
  outputDir: string,
) {
  return `${profileName || 'default'}\0${cdpEndpoint}\0${outputDir}`;
}

async function getBackendClient(input: {
  key: string;
  config: BrowserActionMcpServerConfig;
}): Promise<CachedBackend> {
  const cached = cachedBackends.get(input.key);
  if (cached) {
    clearBackendIdleTimer(cached);
    return cached;
  }
  const pending = pendingBackends.get(input.key);
  if (pending) return pending.promise;
  const pendingEntry: PendingBackend = {
    closeOnResolve: false,
    promise: Promise.resolve(undefined as never),
  };
  pendingEntry.promise = createBackendClient(input)
    .then(async (backend) => {
      if (!pendingEntry.closeOnResolve) return backend;
      await closeCachedBackend(input.key);
      throw new Error('Browser backend was closed before it became ready.');
    })
    .finally(() => {
      pendingBackends.delete(input.key);
    });
  pendingBackends.set(input.key, pendingEntry);
  return pendingEntry.promise;
}

async function createBackendClient(input: {
  key: string;
  config: BrowserActionMcpServerConfig;
}): Promise<CachedBackend> {
  const client = new Client(
    { name: 'myclaw-browser-tool-proxy', version: '1.0.0' },
    { capabilities: {} },
  );
  const transport = new StdioClientTransport({
    command: input.config.command,
    args: [...input.config.args, '--caps', 'vision,pdf,network'],
    env: backendEnv(input.config.env),
    stderr: 'pipe',
  });
  try {
    await client.connect(transport, { timeout: BROWSER_MCP_TIMEOUT_MS });
    const backend = { key: input.key, client, transport };
    cachedBackends.set(input.key, backend);
    return backend;
  } catch (err) {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    throw new Error(`Browser backend startup failed: ${errorMessage(err)}`);
  }
}

function clearBackendIdleTimer(backend: CachedBackend): void {
  if (!backend.idleTimer) return;
  clearTimeout(backend.idleTimer);
  backend.idleTimer = undefined;
}

function scheduleBackendIdleClose(key: string): void {
  const backend = cachedBackends.get(key);
  if (!backend) return;
  clearBackendIdleTimer(backend);
  backend.idleTimer = setTimeout(() => {
    closeCachedBackend(key).catch(() => undefined);
  }, BROWSER_MCP_IDLE_MS);
  backend.idleTimer.unref?.();
}

async function closeCachedBackend(key: string): Promise<void> {
  const backend = cachedBackends.get(key);
  if (!backend) return;
  cachedBackends.delete(key);
  clearBackendIdleTimer(backend);
  await backend.client.close().catch(() => undefined);
  await backend.transport.close().catch(() => undefined);
}

export async function closeBrowserToolBackends(
  profileName?: string,
): Promise<void> {
  const keys = [...cachedBackends.keys()].filter(
    (key) => !profileName || key.startsWith(`${profileName}\0`),
  );
  const pending = [...pendingBackends.entries()].filter(
    ([key]) => !profileName || key.startsWith(`${profileName}\0`),
  );
  for (const [, entry] of pending) entry.closeOnResolve = true;
  await Promise.all([
    ...keys.map((key) => closeCachedBackend(key)),
    ...pending.map(([key, entry]) =>
      entry.promise.then(() => closeCachedBackend(key)).catch(() => undefined),
    ),
  ]);
}

function backendEnv(configEnv: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = { ...configEnv };
  applyAgentEgressNoProxyEnv(env);
  return env;
}

export function ensureBrowserArtifactRoot(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return fs.realpathSync.native(dir);
}

function normalizeBrowserFilePayload(
  payload: Record<string, unknown>,
  options: { fileAccessRoot: string },
): Record<string, unknown> {
  const next = { ...payload };
  if (next.filename !== undefined) {
    next.filename = resolveBrowserOutputPath(
      next.filename,
      options.fileAccessRoot,
    );
  }
  if (next.paths !== undefined) {
    if (!Array.isArray(next.paths)) {
      throw new Error('Browser upload/drop paths must be an array.');
    }
    next.paths = next.paths.map((item) =>
      resolveBrowserInputFilePath(item, options.fileAccessRoot),
    );
  }
  return next;
}

function resolveBrowserPath(value: unknown, fileAccessRoot: string): string {
  const raw = stringValue(value);
  if (!raw) throw new Error('Browser file action requires a path.');
  const root = path.resolve(fileAccessRoot);
  const candidate = path.resolve(root, raw);
  const relative = path.relative(root, candidate);
  if (
    relative === '' ||
    relative.startsWith('..') ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      'Browser file actions are limited to the run browser artifact root.',
    );
  }
  const segments = relative.split(path.sep);
  if (segments.some(isSensitivePathSegment)) {
    throw new Error(
      'Browser file actions cannot access hidden or sensitive paths.',
    );
  }
  return candidate;
}

function resolveBrowserInputFilePath(
  value: unknown,
  fileAccessRoot: string,
): string {
  const candidate = resolveBrowserPath(value, fileAccessRoot);
  const root = ensureBrowserArtifactRoot(fileAccessRoot);
  const stat = fs.lstatSync(candidate);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error('Browser upload/drop paths must be regular files.');
  }
  assertInsideRoot(fs.realpathSync.native(candidate), root);
  return candidate;
}

function resolveBrowserOutputPath(
  value: unknown,
  fileAccessRoot: string,
): string {
  const candidate = resolveBrowserPath(value, fileAccessRoot);
  const root = ensureBrowserArtifactRoot(fileAccessRoot);
  const parent = path.dirname(candidate);
  fs.mkdirSync(parent, { recursive: true });
  assertNoSymlinkPath(parent, path.resolve(fileAccessRoot));
  assertInsideRoot(fs.realpathSync.native(parent), root);
  if (fs.existsSync(candidate) && fs.lstatSync(candidate).isSymbolicLink()) {
    throw new Error('Browser file actions cannot write through symlinks.');
  }
  return candidate;
}

function assertInsideRoot(candidate: string, root: string): void {
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(
      'Browser file actions are limited to the run browser artifact root.',
    );
  }
}

function assertNoSymlinkPath(target: string, root: string): void {
  let current = root;
  for (const segment of path.relative(root, target).split(path.sep)) {
    if (!segment) continue;
    current = path.join(current, segment);
    if (fs.lstatSync(current).isSymbolicLink()) {
      throw new Error('Browser file actions cannot traverse symlinks.');
    }
  }
}

function isSensitivePathSegment(segment: string): boolean {
  const lower = segment.toLowerCase();
  return (
    lower.startsWith('.') ||
    lower === 'settings.yaml' ||
    lower === 'secrets' ||
    lower === 'credentials' ||
    lower === 'browser-profiles' ||
    lower === 'ipc'
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function browserActionTimeoutMs(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return BROWSER_ACTION_TIMEOUT_MS;
  }
  return Math.max(
    MIN_BROWSER_ACTION_TIMEOUT_MS,
    Math.min(MAX_BROWSER_ACTION_TIMEOUT_MS, Math.trunc(value)),
  );
}

export function formatBackendError(toolName: string, err: unknown): string {
  const message = errorMessage(err);
  if (/timed? out|timeout/i.test(message)) {
    return `Browser backend timeout while running ${toolName}: ${message}`;
  }
  return `Browser backend failed while running ${toolName}: ${message}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
