import { redactString } from '../infrastructure/logging/logger.js';

const SENSITIVE_TEXT_PATTERNS: RegExp[] = [
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|AUTH)[A-Z0-9_]*)\s*[:=]\s*([^\s"']+)/gi,
  /\b(Bearer)\s+[A-Za-z0-9._\-~+/]+=*/gi,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

const SANDBOX_BLOCKED_PATTERNS: RegExp[] = [
  /\bsandbox(?:-exec)?\b.*\bdeny/i,
  /\bseatbelt\b/i,
  /\bbubblewrap\b/i,
  /\bbwrap\b/i,
  /\bseccomp\b/i,
  /\blandlock\b/i,
  /\boperation not permitted\b/i,
];

export function sanitizeRunnerLogText(value: string, maxChars = 4000): string {
  let text = redactString(value);
  for (const pattern of SENSITIVE_TEXT_PATTERNS) {
    text = text.replace(pattern, (_match, p1) => {
      if (typeof p1 === 'string' && p1.length > 0) {
        return `${p1}=[REDACTED]`;
      }
      return '[REDACTED]';
    });
  }
  if (text.length > maxChars) {
    return `${text.slice(0, maxChars)}...[truncated]`;
  }
  return text;
}

export function stderrLooksLikeSandboxBlock(stderr: string): boolean {
  return SANDBOX_BLOCKED_PATTERNS.some((pattern) => pattern.test(stderr));
}
