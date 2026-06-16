const RUNTIME_LOG_PROVIDER_FIELDS =
  'sessionId|newSessionId|providerSessionId|externalSessionId|latestProviderSessionId|session_id';
const RUNTIME_LOG_PROVIDER_FIELD_PATTERNS: RegExp[] = [
  new RegExp(
    `(["'](?:${RUNTIME_LOG_PROVIDER_FIELDS})["']\\s*:\\s*")([^"\\r\\n]*)(")`,
    'gi',
  ),
  new RegExp(
    `(["'](?:${RUNTIME_LOG_PROVIDER_FIELDS})["']\\s*:\\s*')([^'\\r\\n]*)(')`,
    'gi',
  ),
  new RegExp(
    `\\b((?:${RUNTIME_LOG_PROVIDER_FIELDS})\\s*[:=]\\s*)([^\\s"',}\\]]+)`,
    'gi',
  ),
  new RegExp(
    `\\b((?:${RUNTIME_LOG_PROVIDER_FIELDS})\\s+)([^\\s"',}\\]]+)`,
    'gi',
  ),
];
const RUNTIME_LOG_PROVIDER_VALUE_PATTERNS: RegExp[] = [
  /\bclaude-session-[A-Za-z0-9._:-]+\b/g,
  /\bprovider-session:[A-Za-z0-9._:-]+\b/g,
];
const RUNTIME_LOG_REDACT_KEY_PATTERN =
  /^(sessionId|newSessionId|providerSessionId|externalSessionId|latestProviderSessionId|session_id)$/i;

function redactRuntimeLogString(value: string): string {
  let out = value;
  for (const pattern of RUNTIME_LOG_PROVIDER_FIELD_PATTERNS) {
    out = out.replace(pattern, (_match, prefix, _secret, suffix = '') => {
      return `${prefix}[REDACTED]${suffix}`;
    });
  }
  for (const pattern of RUNTIME_LOG_PROVIDER_VALUE_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}

function redactRuntimeLogValue(value: unknown, depth: number): unknown {
  if (depth > 6) return '[TRUNCATED_DEPTH]';
  if (typeof value === 'string') return redactRuntimeLogString(value);
  if (Array.isArray(value)) {
    return value.map((entry) => redactRuntimeLogValue(entry, depth + 1));
  }
  if (value instanceof Error) {
    const errorPayload: Record<string, unknown> = {
      type: value.constructor?.name || 'Error',
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
    const withCause = value as Error & {
      cause?: unknown;
      code?: unknown;
    };
    if ('code' in withCause) {
      errorPayload.code = withCause.code;
    }
    if ('cause' in withCause) {
      errorPayload.cause = withCause.cause;
    }
    return redactRuntimeLogValue(errorPayload, depth + 1);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (RUNTIME_LOG_REDACT_KEY_PATTERN.test(key)) {
        out[key] = '[REDACTED]';
        continue;
      }
      out[key] = redactRuntimeLogValue(entry, depth + 1);
    }
    return out;
  }
  return value;
}

export const runtimeLogger = {
  info(payload: Record<string, unknown>, message: string) {
    console.info(
      redactRuntimeLogString(message),
      redactRuntimeLogValue(payload, 0),
    );
  },
  warn(payload: Record<string, unknown>, message: string) {
    console.warn(
      redactRuntimeLogString(message),
      redactRuntimeLogValue(payload, 0),
    );
  },
  error(payload: Record<string, unknown>, message: string) {
    console.error(
      redactRuntimeLogString(message),
      redactRuntimeLogValue(payload, 0),
    );
  },
};
