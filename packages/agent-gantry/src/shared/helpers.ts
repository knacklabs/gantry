import type { GantryFetchToolResult } from './types.js';

export async function parseResponseBody(response: Response): Promise<unknown> {
  if (typeof response.text !== 'function') {
    const responseWithJson = response as Response & {
      readonly json?: () => Promise<unknown>;
    };
    return typeof responseWithJson.json === 'function'
      ? await responseWithJson.json()
      : null;
  }
  const text = await response.text();
  if (!text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function gantryHttpError(
  message: string,
  statusCode: number,
  body: unknown,
): Error {
  const suffix = typeof body === 'string' && body.trim() ? `: ${body}` : '';
  const error = new Error(`${message} (${statusCode})${suffix}`);
  Object.assign(error, { statusCode, body });
  return error;
}

export function requireNonEmpty(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${fieldName} is required.`);
  }
  return normalized;
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export function trimToBudget(text: string, maxBytes: number): string {
  return text.length > maxBytes ? text.slice(0, maxBytes) : text;
}

export function extractHtmlTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match?.[1]?.replace(/\s+/g, ' ').trim() || null;
}

export function htmlToReadableText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export function detectBlockedReason(
  statusCode: number,
  contentType: string | null,
  text: string,
): GantryFetchToolResult['blockedReason'] {
  const normalized = text.toLowerCase();
  if (statusCode === 404 || statusCode === 410) return 'dead';
  if (statusCode >= 400) return 'unsupported';
  if (
    contentType &&
    !contentType.includes('html') &&
    !contentType.includes('text') &&
    !contentType.includes('json')
  )
    return 'unsupported';
  if (
    normalized.includes('captcha') ||
    normalized.includes('cloudflare ray id')
  )
    return 'captcha';
  if (
    normalized.includes('login required') ||
    normalized.includes('sign in') ||
    normalized.includes('please login')
  )
    return 'login_required';
  if (
    normalized.includes('domain for sale') ||
    normalized.includes('buy this domain') ||
    normalized.includes('parked free')
  )
    return 'parked';
  return null;
}

export function readString(
  record: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function readNumber(
  record: Record<string, unknown> | null,
  key: string,
): number | null {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.flatMap((item) =>
        typeof item === 'string' && item.trim() ? [item.trim()] : [],
      )
    : [];
}

export function readStringValue(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

export function readOptionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function readOptionalNumberOrString(
  value: unknown,
): number | string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return readOptionalString(value);
}

export function parseJsonRecord(value: string): Record<string, unknown> {
  const openedFence = stripOpeningJsonFence(value);
  const candidates = [
    stripOuterJsonFence(value),
    ...extractFencedJsonCandidates(value),
    ...(openedFence === value
      ? []
      : [openedFence, ...extractBalancedJsonObjectCandidates(openedFence)]),
  ];
  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const record = asRecord(parsed);
      if (!record) {
        throw new Error('Structured task model output must be a JSON object.');
      }
      return record;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error('Structured task model output must be valid JSON.');
}

export function parseCompleteJsonRecord(value: string): Record<string, unknown> {
  const trimmed = value.trim();
  const fenced = /^```(?:json|JSON)?\s*\r?\n?([\s\S]*?)\r?\n?```$/u.exec(trimmed);
  const parsed = JSON.parse(fenced?.[1]?.trim() ?? trimmed) as unknown;
  const record = asRecord(parsed);
  if (!record) {
    throw new Error('Structured task model output must be a JSON object.');
  }
  return record;
}

function stripOuterJsonFence(value: string): string {
  const trimmed = value.trim();
  const fenced = /^```(?:json|JSON)?\s*\r?\n?([\s\S]*?)\r?\n?```$/u.exec(
    trimmed,
  );
  if (!fenced) return value;

  const inner = fenced[1]?.trim() ?? '';
  if (!isJsonShaped(inner)) return value;
  return inner;
}

function stripOpeningJsonFence(value: string): string {
  return value
    .trim()
    .replace(/^```(?:json|JSON)?\s*\r?\n?/u, '')
    .trim();
}

function extractFencedJsonCandidates(value: string): string[] {
  const candidates: string[] = [];
  const fencedBlocks = value.matchAll(
    /```(?:json|JSON)?\s*\r?\n?([\s\S]*?)\r?\n?```/gu,
  );
  for (const block of fencedBlocks) {
    const inner = block[1]?.trim() ?? '';
    if (isJsonShaped(inner)) candidates.push(inner);
  }
  return candidates;
}

function extractBalancedJsonObjectCandidates(value: string): string[] {
  const candidates: string[] = [];
  const text = value.trim();
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '{') depth += 1;
      if (char === '}') depth -= 1;
      if (depth === 0) {
        candidates.push(text.slice(start, index + 1));
        start = index;
        break;
      }
      if (depth < 0) break;
    }
  }
  return candidates;
}

function isJsonShaped(value: string): boolean {
  return (
    (value.startsWith('{') && value.endsWith('}')) ||
    (value.startsWith('[') && value.endsWith(']'))
  );
}
