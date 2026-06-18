const SLACK_THREAD_TS_PATTERN = /^\d{10,}\.\d+$/;
const CANONICAL_SLACK_THREAD_PREFIX = 'thread:sl:';

export function slackThreadTsFromThreadId(
  threadId: string | null | undefined,
): string | undefined {
  const normalized = threadId?.trim();
  if (!normalized) return undefined;
  if (SLACK_THREAD_TS_PATTERN.test(normalized)) return normalized;
  if (!normalized.startsWith(CANONICAL_SLACK_THREAD_PREFIX)) return undefined;

  const candidate = normalized.slice(normalized.lastIndexOf(':') + 1);
  return SLACK_THREAD_TS_PATTERN.test(candidate) ? candidate : undefined;
}
