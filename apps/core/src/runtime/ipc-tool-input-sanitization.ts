import { isPlainObject } from '../shared/object.js';

const TOOL_INPUT_MAX_DEPTH = 2;
const TOOL_INPUT_MAX_KEYS = 40;
const TOOL_INPUT_MAX_ARRAY_ENTRIES = 20;
const TOOL_INPUT_MAX_STRING_LENGTH = 500;

export const SENSITIVE_TOOL_INPUT_KEY_PATTERN =
  /(secret|token|password|passphrase|credential|api[_-]?key|key|authorization|bearer|cookie|session)/i;

const AUTH_VALUE_PATTERN = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const KNOWN_TOKEN_PATTERN =
  /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[po]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,}|xox[abp]-[A-Za-z0-9-]{8,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,})\b/g;
const ENV_VALUE_PATTERN =
  /\b([A-Za-z_][A-Za-z0-9_-]*)(\s*(?:=|:)\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/g;
const URL_USERINFO_PATTERN = /(:\/\/)[^\s/@:]+:[^\s/@]+@/g;

export function redactSensitiveToolInputString(value: string): string {
  return value
    .replace(URL_USERINFO_PATTERN, '$1[REDACTED]@')
    .replace(AUTH_VALUE_PATTERN, '[REDACTED]')
    .replace(KNOWN_TOKEN_PATTERN, '[REDACTED]')
    .replace(ENV_VALUE_PATTERN, (match, key: string, separator: string) =>
      SENSITIVE_TOOL_INPUT_KEY_PATTERN.test(key)
        ? `${key}${separator}[REDACTED]`
        : match,
    );
}

interface SanitizationState {
  alteredPaths: Set<string>;
  redactedPaths: Set<string>;
  // Content-REMOVAL paths (length/depth/entry/key truncation) — distinct from
  // redaction, which replaces a value in place. A path can be both redacted and
  // truncated, so this must be tracked independently, not derived by subtraction.
  truncatedPaths: Set<string>;
  maxStringLength: number;
}

function childPath(path: string, key: string | number): string {
  return path ? `${path}.${key}` : String(key);
}

function sanitizeValue(
  value: unknown,
  depth: number,
  path: string,
  state: SanitizationState,
): unknown {
  if (depth > TOOL_INPUT_MAX_DEPTH) {
    state.alteredPaths.add(path);
    state.truncatedPaths.add(path);
    return '[TRUNCATED_DEPTH]';
  }
  if (typeof value === 'string') {
    const redacted = redactSensitiveToolInputString(value);
    if (redacted !== value) {
      state.alteredPaths.add(path);
      state.redactedPaths.add(path);
    }
    if (redacted.length <= state.maxStringLength) return redacted;
    state.alteredPaths.add(path);
    state.truncatedPaths.add(path);
    return `${redacted.slice(0, state.maxStringLength)}...[truncated]`;
  }
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const kept = value
      .slice(0, TOOL_INPUT_MAX_ARRAY_ENTRIES)
      .map((entry, index) =>
        sanitizeValue(entry, depth + 1, childPath(path, index), state),
      );
    for (
      let index = TOOL_INPUT_MAX_ARRAY_ENTRIES;
      index < value.length;
      index += 1
    ) {
      state.alteredPaths.add(childPath(path, index));
      state.truncatedPaths.add(childPath(path, index));
    }
    return kept;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    const keys = Object.keys(value);
    for (const key of keys.slice(0, TOOL_INPUT_MAX_KEYS)) {
      const entry = value[key];
      const entryPath = childPath(path, key);
      if (SENSITIVE_TOOL_INPUT_KEY_PATTERN.test(key)) {
        state.alteredPaths.add(entryPath);
        state.redactedPaths.add(entryPath);
        out[key] = '[REDACTED]';
        continue;
      }
      out[key] = sanitizeValue(entry, depth + 1, entryPath, state);
    }
    if (keys.length > TOOL_INPUT_MAX_KEYS) {
      out.__omitted_keys = 'more';
      for (const key of keys.slice(TOOL_INPUT_MAX_KEYS)) {
        state.alteredPaths.add(childPath(path, key));
        state.truncatedPaths.add(childPath(path, key));
      }
    }
    return out;
  }
  state.alteredPaths.add(path);
  return String(value);
}

export function sanitizeIpcToolInput(
  value: unknown,
  maxStringLength = TOOL_INPUT_MAX_STRING_LENGTH,
): {
  toolInput?: Record<string, unknown>;
  altered: boolean;
  alteredPaths: string[];
  redactedPaths: string[];
  truncatedPaths: string[];
} {
  if (!isPlainObject(value)) {
    const alteredPaths = value === undefined ? [] : ['$'];
    return {
      altered: alteredPaths.length > 0,
      alteredPaths,
      redactedPaths: [],
      truncatedPaths: alteredPaths,
    };
  }
  const state: SanitizationState = {
    alteredPaths: new Set(),
    redactedPaths: new Set(),
    truncatedPaths: new Set(),
    maxStringLength,
  };
  const toolInput = sanitizeValue(value, 0, '', state) as Record<
    string,
    unknown
  >;
  const alteredPaths = [...state.alteredPaths];
  const redactedPaths = [...state.redactedPaths];
  return {
    toolInput,
    altered: alteredPaths.length > 0,
    alteredPaths,
    redactedPaths,
    // Only genuine content-removal paths — a redact-only path is NOT truncated,
    // and a path that is both redacted and truncated still counts as truncated.
    truncatedPaths: [...state.truncatedPaths],
  };
}
