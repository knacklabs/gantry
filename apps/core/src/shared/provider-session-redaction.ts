const PROVIDER_SESSION_FIELD_NAMES =
  'sessionId|newSessionId|providerSessionId|externalSessionId|latestProviderSessionId|session_id';

const PROVIDER_SESSION_FIELD_PATTERNS: RegExp[] = [
  new RegExp(
    `(["'](?:${PROVIDER_SESSION_FIELD_NAMES})["']\\s*:\\s*")([^"\\r\\n]*)(")`,
    'gi',
  ),
  new RegExp(
    `(["'](?:${PROVIDER_SESSION_FIELD_NAMES})["']\\s*:\\s*')([^'\\r\\n]*)(')`,
    'gi',
  ),
  new RegExp(
    `\\b((?:${PROVIDER_SESSION_FIELD_NAMES})\\s*[:=]\\s*)([^\\s"',}\\]]+)`,
    'gi',
  ),
  new RegExp(
    `\\b((?:${PROVIDER_SESSION_FIELD_NAMES})\\s+)([^\\s"',}\\]]+)`,
    'gi',
  ),
];

const PROVIDER_SESSION_SHAPE_PATTERNS: RegExp[] = [
  /\bclaude-session-[A-Za-z0-9._:-]+\b/g,
  /\bprovider-session:[A-Za-z0-9._:-]+\b/g,
];

export function redactProviderSessionHandlesInText(value: string): string {
  let out = value;
  for (const pattern of PROVIDER_SESSION_FIELD_PATTERNS) {
    out = out.replace(pattern, (_match, prefix, _secret, suffix = '') => {
      return `${prefix}[REDACTED]${suffix}`;
    });
  }
  for (const pattern of PROVIDER_SESSION_SHAPE_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}
