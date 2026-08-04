import { randomBytes } from 'node:crypto';

export class SlackCanvasProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

export function opaqueHandle(kind: 'canvas' | 'section'): string {
  return `gantry_${kind}_${randomBytes(18).toString('base64url')}`;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function requiredString(value: unknown, label: string): string {
  const result = optionalString(value);
  if (!result) throw new Error(`Slack response omitted ${label}.`);
  return result;
}

export async function boundedResponseText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`Slack canvas export exceeds ${maxBytes} bytes.`);
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) {
      throw new Error(`Slack canvas export exceeds ${maxBytes} bytes.`);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel('canvas export too large');
      throw new Error(`Slack canvas export exceeds ${maxBytes} bytes.`);
    }
    chunks.push(next.value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(combined);
}

export const WRITE_SCOPE_ERROR =
  'Slack canvas write failed because the app needs canvases:write (and files:read for canvas links). Add the scopes and reinstall the app to this workspace, then retry.';
export const READ_SCOPE_ERROR =
  'Slack canvas read failed because the app needs canvases:read and files:read. Add both scopes and reinstall the app to this workspace, then retry.';
export const CHANNEL_SCOPE_ERROR =
  'Slack could not resolve the channel canvas because the app needs channels:read. Add the scope and reinstall the app to this workspace, then retry.';

export function asCanvasReadError(error: unknown): Error {
  if (
    error instanceof Error &&
    (error.message === READ_SCOPE_ERROR ||
      error.message.includes('canvas export is unavailable'))
  ) {
    return error;
  }
  const detail = error instanceof Error ? error.message : 'unknown failure';
  // Only genuine scope failures get scope guidance; others keep their category.
  if (detail.includes('missing_scope')) {
    return new Error(`${READ_SCOPE_ERROR} Export detail: ${detail}`);
  }
  if (
    ['canvas_not_found', 'not_found', 'canvas_deleted', 'file_deleted'].some(
      (code) => detail.includes(code),
    )
  ) {
    return new Error(
      `Canvas read failed: the canvas no longer exists or the handle is stale (${detail}). Re-run the listing to get a fresh handle.`,
    );
  }
  if (detail.includes('ratelimited')) {
    return new Error(
      `Canvas read failed: Slack rate limit (${detail}). Retry shortly.`,
    );
  }
  return new Error(
    `Canvas read failed (${detail}). This is likely transient; retry, and if it persists check the Slack app installation.`,
  );
}

export function isSlackFileUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      (parsed.hostname === 'slack.com' ||
        parsed.hostname.endsWith('.slack.com'))
    );
  } catch {
    return false;
  }
}

export function parseSlackConversationJid(jid: string): string {
  if (!jid.startsWith('sl:') || !jid.slice(3).trim()) {
    throw new Error('Canvas tools are available only in a Slack conversation.');
  }
  return jid.slice(3).trim();
}

// Slack has represented the channel canvas as properties.canvas.file_id
// (legacy), channel_solutions.canvas_ids, and a canvas tab; accept each.
export function boundCanvasIdFromConversationInfo(
  response: Record<string, unknown>,
): string | undefined {
  const properties = asRecord(asRecord(response.channel)?.properties);
  const solutions = asRecord(properties?.channel_solutions);
  const solutionIds = Array.isArray(solutions?.canvas_ids)
    ? solutions.canvas_ids
    : [];
  const tabs = Array.isArray(properties?.tabs) ? properties.tabs : [];
  const canvasTab = tabs.map(asRecord).find((tab) => tab?.type === 'canvas');
  return (
    optionalString(asRecord(properties?.canvas)?.file_id) ??
    optionalString(solutionIds[0]) ??
    optionalString(asRecord(canvasTab?.data)?.file_id)
  );
}

export interface SlackCanvasFileLike {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  filetype?: string;
  mode?: string;
  file_access?: string;
  url_private?: string;
  url_private_download?: string;
}

// Handle records carry no provider-account field on purpose: each
// SlackCanvasService instance is constructed per Slack connection, so the
// maps are account-scoped structurally and cross-account handle submission
// fails closed on an unknown random handle.
export interface CanvasHandleRecord {
  conversationJid: string;
  canvasId: string;
  access: 'read' | 'write';
}

export interface SectionHandleRecord {
  conversationJid: string;
  canvasId: string;
  label: string;
  sectionId: string;
}

export const SLACK_CANVAS_FETCH_TIMEOUT_MS = 45_000;

export function remainingTimeoutMs(deadlineAt: number): number {
  return Math.max(
    1_000,
    Math.min(SLACK_CANVAS_FETCH_TIMEOUT_MS, deadlineAt - Date.now()),
  );
}
