import { createHash } from 'node:crypto';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function sha256Base64Url(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

export function stableSha256Json(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function boundedSha256Value(value: unknown): string {
  const hash = createHash('sha256');
  const seen = new Set<unknown>();
  let visited = 0;
  const visit = (current: unknown, depth: number) => {
    if (visited >= 10_000 || depth > 32) {
      hash.update('[bounded]');
      return;
    }
    visited += 1;
    if (current === null || current === undefined) {
      hash.update(String(current));
      return;
    }
    if (typeof current !== 'object') {
      hash.update(`${typeof current}:${String(current).slice(0, 65_536)}`);
      return;
    }
    if (seen.has(current)) {
      hash.update('[circular]');
      return;
    }
    seen.add(current);
    if (Array.isArray(current)) {
      hash.update('[');
      current.forEach((item) => visit(item, depth + 1));
      hash.update(']');
      return;
    }
    hash.update('{');
    for (const key of Object.keys(current as Record<string, unknown>).sort()) {
      hash.update(key);
      visit((current as Record<string, unknown>)[key], depth + 1);
    }
    hash.update('}');
  };
  visit(value, 0);
  return `sha256:${hash.digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}
