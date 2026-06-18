const SLACK_RETRY_DELAY_FALLBACK_MS = 1000;
const SLACK_RETRY_DELAY_MAX_MS = 5000;

export function clampSlackRetryDelayMs(delayMs: number): number {
  if (!Number.isFinite(delayMs) || delayMs <= 0) {
    return SLACK_RETRY_DELAY_FALLBACK_MS;
  }
  return Math.min(SLACK_RETRY_DELAY_MAX_MS, Math.max(1, Math.round(delayMs)));
}

export function slackRateLimitRetryDelayMs(input: unknown): number | null {
  const candidate = input as {
    retry_after?: unknown;
    retryAfter?: unknown;
    data?: { retry_after?: unknown; retryAfter?: unknown };
    headers?: { retry_after?: unknown; retryAfter?: unknown };
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    error?: unknown;
  };
  const values = [
    candidate.retry_after,
    candidate.retryAfter,
    candidate.data?.retry_after,
    candidate.data?.retryAfter,
    candidate.headers?.retry_after,
    candidate.headers?.retryAfter,
  ];
  for (const value of values) {
    if (typeof value === 'number' && value > 0) {
      return clampSlackRetryDelayMs(value * 1000);
    }
    if (typeof value === 'string') {
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        return clampSlackRetryDelayMs(parsed * 1000);
      }
    }
  }
  if (
    candidate.status === 429 ||
    candidate.statusCode === 429 ||
    candidate.code === 429 ||
    candidate.error === 'ratelimited'
  ) {
    return SLACK_RETRY_DELAY_FALLBACK_MS;
  }
  return null;
}
