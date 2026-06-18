// Runtime failover-eligibility classifier. There is NO structured status field
// on an agent run's error: the model gateway is a transparent proxy, so an
// upstream provider's 401/429/503 (and pre-spawn "not configured" errors) reach
// the runner as an `output.error` STRING. This module classifies that string to
// decide whether a model-family run may fail over to the NEXT configured
// provider for the same family. It mirrors the existing string-matching style of
// `isMissingProviderSessionError` (group-agent-runner.ts).
//
// Failover is eligible when the failure is plausibly provider-specific and a
// different provider might succeed: auth, rate-limit, server/down, and pre-spawn
// "not configured". It is NOT eligible for a user stop, a missing-provider
// session (handled FIRST by the stale-session retry), or success/empty.

// Out-of-credits / payment-required: a DIFFERENT provider may still have credit,
// so this is treated as failover-eligible by default. Flip to `false` to make a
// billing failure terminal (no failover) without touching the regex sets.
export const FAILOVER_ON_BILLING_ERROR = true;

// Auth: bad/expired/missing API key, 401/403, authentication errors.
const AUTH_PATTERNS: readonly RegExp[] = [
  /\b401\b/,
  /\b403\b/,
  /\binvalid[\s_-]?api[\s_-]?key\b/i,
  /\bauthentication\b/i,
  /\bunauthorized\b/i,
  /\bforbidden\b/i,
];

// Rate limit: 429, rate_limit / rate limit.
const RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  /\b429\b/,
  /\brate[\s_-]?limit/i,
  /\btoo many requests\b/i,
];

// Server/down: 5xx, overloaded, unavailable, timeouts.
const SERVER_PATTERNS: readonly RegExp[] = [
  /\b500\b/,
  /\b502\b/,
  /\b503\b/,
  /\b504\b/,
  /\boverloaded\b/i,
  /\bunavailable\b/i,
  /\btimed out\b/i,
  /\btimeout\b/i,
  /\bbad gateway\b/i,
  /\bgateway timeout\b/i,
];

// Pre-spawn "not configured" / setup-required / materialization failures.
const NOT_CONFIGURED_PATTERNS: readonly RegExp[] = [
  /\bis not configured\b/i,
  /\bnot configured\b/i,
  /\bsetup required\b/i,
  /\bllm runtime materialization failed\b/i,
];

// Billing / out-of-credits / payment required.
const BILLING_PATTERNS: readonly RegExp[] = [
  /\bout of credits\b/i,
  /\binsufficient[\s_-]?(?:credit|balance|funds|quota)\b/i,
  /\bpayment required\b/i,
  /\b402\b/,
];

// Explicitly NON-eligible signals. These short-circuit eligibility even if a
// later token would otherwise match, because they identify a non-provider cause.
//  - "stopped by request": a user/host stop, not a provider failure.
//  - missing provider session: handled FIRST by the stale-session retry, which
//    re-runs on the SAME provider; failing it over would skip that recovery.
//    The REAL adapter marker strings are matched directly so they short-circuit
//    even if a session error is ever wrapped with an HTTP code / "unavailable" /
//    "not configured" token (which would otherwise classify it failover-
//    eligible). The two execution adapters throw, respectively, "No conversation
//    found with session ID" and "No DeepAgents session found with session ID".
//    The generic "provider session ... missing/expired/not found" pattern is
//    kept as an extra net for any future paraphrase of the same cause.
const NON_ELIGIBLE_PATTERNS: readonly RegExp[] = [
  /\bstopped by request\b/i,
  /\bno (?:conversation|deepagents session) found with session id\b/i,
  /\bprovider session\b.*\b(?:missing|expired|not found)\b/i,
];

function matchesAny(error: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(error));
}

// True when `error` indicates a provider-specific failure that the NEXT
// configured family provider might survive. Empty/undefined (no error, or a
// success frame) is never eligible.
export function isFailoverEligibleError(error: string | undefined): boolean {
  const text = (error ?? '').trim();
  if (!text) return false;
  if (matchesAny(text, NON_ELIGIBLE_PATTERNS)) return false;
  if (
    matchesAny(text, AUTH_PATTERNS) ||
    matchesAny(text, RATE_LIMIT_PATTERNS) ||
    matchesAny(text, SERVER_PATTERNS) ||
    matchesAny(text, NOT_CONFIGURED_PATTERNS)
  ) {
    return true;
  }
  if (FAILOVER_ON_BILLING_ERROR && matchesAny(text, BILLING_PATTERNS)) {
    return true;
  }
  return false;
}
