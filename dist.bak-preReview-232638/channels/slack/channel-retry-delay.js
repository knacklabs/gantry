const SLACK_RETRY_DELAY_FALLBACK_MS = 1000;
const SLACK_RETRY_DELAY_MAX_MS = 5000;
const SLACK_RETRY_JITTER_MAX_MS = 250;
export function clampSlackRetryDelayMs(delayMs) {
    if (!Number.isFinite(delayMs) || delayMs <= 0) {
        return SLACK_RETRY_DELAY_FALLBACK_MS;
    }
    return Math.min(SLACK_RETRY_DELAY_MAX_MS, Math.max(1, Math.round(delayMs)));
}
function withSlackRetryJitterMs(delayMs) {
    const baseMs = clampSlackRetryDelayMs(delayMs);
    // ponytail: keep jitter local and bounded; no seeded backoff machinery.
    const jitterMs = Math.floor(Math.random() *
        Math.min(SLACK_RETRY_JITTER_MAX_MS, Math.max(1, baseMs / 5)));
    return clampSlackRetryDelayMs(baseMs + jitterMs);
}
export function slackRateLimitRetryDelayMs(input) {
    const candidate = input;
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
            return withSlackRetryJitterMs(value * 1000);
        }
        if (typeof value === 'string') {
            const parsed = Number.parseFloat(value);
            if (Number.isFinite(parsed) && parsed > 0) {
                return withSlackRetryJitterMs(parsed * 1000);
            }
        }
    }
    if (candidate.status === 429 ||
        candidate.statusCode === 429 ||
        candidate.code === 429 ||
        candidate.error === 'ratelimited') {
        return withSlackRetryJitterMs(SLACK_RETRY_DELAY_FALLBACK_MS);
    }
    return null;
}
