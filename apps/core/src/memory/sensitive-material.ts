const KNOWN_SECRET_PATTERNS: Array<{ reason: string; pattern: RegExp }> = [
  {
    reason: 'provider_token',
    pattern:
      /\b(sk-[a-z0-9]{20,}|sk-ant-[a-z0-9_-]{20,}|gh[opusr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|glpat-[a-z0-9_-]{20,}|xox[baprs]-[a-z0-9-]{20,}|xoxx-[a-z0-9-]{20,})\b/i,
  },
  {
    reason: 'aws_access_key',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  },
  {
    reason: 'jwt_token',
    pattern:
      /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9._-]{10,}\.[a-zA-Z0-9._-]{10,}\b/,
  },
  {
    reason: 'pem_private_key',
    pattern:
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/i,
  },
  {
    reason: 'secret_assignment',
    pattern:
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|client[_-]?secret|private[_-]?key|session[_-]?id)\b\s*(?:=|:|is)\s*['"]?[a-z0-9._~+/-]{8,}['"]?/i,
  },
  {
    reason: 'bearer_token',
    pattern: /\bbearer\s+[a-z0-9._~+/-]{16,}\b/i,
  },
];

const HIGH_RISK_CONTEXT_PATTERN =
  /\b(token|secret|password|passphrase|credential|auth|authorization|api[_-]?key|session|cookie|bearer)\b/i;
const CANDIDATE_TOKEN_PATTERN = /[A-Za-z0-9._~+/\-=]{24,}/g;

function shannonEntropy(value: string): number {
  if (!value) return 0;
  const counts = new Map<string, number>();
  for (const ch of value) {
    counts.set(ch, (counts.get(ch) || 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function tokenClassCount(value: string): number {
  let classes = 0;
  if (/[a-z]/.test(value)) classes += 1;
  if (/[A-Z]/.test(value)) classes += 1;
  if (/[0-9]/.test(value)) classes += 1;
  if (/[^A-Za-z0-9]/.test(value)) classes += 1;
  return classes;
}

function looksLikeOpaqueSecretToken(raw: string): boolean {
  const token = raw.replace(/^['"`]+|['"`]+$/g, '');
  if (token.length < 24 || token.length > 1024) return false;
  if (token.includes('://')) return false;
  if (!/[0-9]/.test(token)) return false;
  if (tokenClassCount(token) < 3) return false;
  return shannonEntropy(token) >= 3.5;
}

export function classifySensitiveMemoryMaterial(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  for (const check of KNOWN_SECRET_PATTERNS) {
    if (check.pattern.test(trimmed)) {
      return check.reason;
    }
  }
  return null;
}

export function detectPotentialUnredactedSecret(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.includes('[REDACTED_SECRET]')) return null;
  const candidates = trimmed.match(CANDIDATE_TOKEN_PATTERN) || [];
  for (const token of candidates) {
    if (!looksLikeOpaqueSecretToken(token)) continue;
    if (token.length >= 40 || HIGH_RISK_CONTEXT_PATTERN.test(trimmed)) {
      return 'high_entropy_credential_like_token';
    }
  }
  return null;
}

export function redactSensitiveText(raw: string): string {
  let redacted = raw;
  redacted = redacted.replace(
    /\b(sk-[a-z0-9]{20,}|sk-ant-[a-z0-9_-]{20,}|gh[opusr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}|glpat-[a-z0-9_-]{20,}|xox[baprs]-[a-z0-9-]{20,}|xoxx-[a-z0-9-]{20,})\b/gi,
    '[REDACTED_SECRET]',
  );
  redacted = redacted.replace(
    /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    '[REDACTED_SECRET]',
  );
  redacted = redacted.replace(
    /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9._-]{10,}\.[a-zA-Z0-9._-]{10,}\b/g,
    '[REDACTED_SECRET]',
  );
  redacted = redacted.replace(
    /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/gi,
    '[REDACTED_SECRET]',
  );
  redacted = redacted.replace(
    /\bbearer\s+[a-z0-9._~+/-]{16,}\b/gi,
    'bearer [REDACTED_SECRET]',
  );
  redacted = redacted.replace(
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|client[_-]?secret|private[_-]?key|session[_-]?id)\b\s*(?:=|:|is)\s*['"]?[a-z0-9._~+/-]{8,}['"]?/gi,
    '$1=[REDACTED_SECRET]',
  );
  return redacted;
}

export function sanitizeOutboundLlmText(raw: string): {
  text: string;
  redacted: boolean;
  blocked: boolean;
  reason?: string;
} {
  const redactedText = redactSensitiveText(raw);
  const blockedReason = detectPotentialUnredactedSecret(redactedText);
  return {
    text: blockedReason ? '[REDACTED_POTENTIALLY_SENSITIVE]' : redactedText,
    redacted: redactedText !== raw,
    blocked: Boolean(blockedReason),
    ...(blockedReason ? { reason: blockedReason } : {}),
  };
}
