const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;
const MAX_MESSAGE_RUNS = 3;
const MAX_JOB_RUNS = 4;
export const UNLIMITED_QUEUE_BACKLOG = 0;

export interface GroupQueuePolicy {
  maxRetries: number;
  baseRetryMs: number;
  maxMessageRuns: number;
  maxJobRuns: number;
  maxMessageBacklog: number;
  maxTaskBacklog: number;
}

export interface GroupQueuePolicyOptions {
  maxRetries?: number;
  baseRetryMs?: number;
  maxMessageRuns?: number;
  maxJobRuns?: number;
  maxMessageBacklog?: number;
  maxTaskBacklog?: number;
}

export function createGroupQueuePolicy(
  options: GroupQueuePolicyOptions,
): GroupQueuePolicy {
  return {
    maxRetries: normalizeNonNegativeInteger(options.maxRetries, MAX_RETRIES),
    baseRetryMs: normalizeNonNegativeInteger(
      options.baseRetryMs,
      BASE_RETRY_MS,
    ),
    maxMessageRuns: normalizePositiveInteger(
      options.maxMessageRuns,
      MAX_MESSAGE_RUNS,
    ),
    maxJobRuns: normalizeNonNegativeInteger(options.maxJobRuns, MAX_JOB_RUNS),
    maxMessageBacklog: normalizeNonNegativeInteger(
      options.maxMessageBacklog,
      UNLIMITED_QUEUE_BACKLOG,
    ),
    maxTaskBacklog: normalizeNonNegativeInteger(
      options.maxTaskBacklog,
      UNLIMITED_QUEUE_BACKLOG,
    ),
  };
}

export function continuationSenderMatchesRequiredUser(
  senderUserIds: readonly string[] | null | undefined,
  requiredUserId: string,
): boolean {
  const normalizedSenderIds = new Set<string>();
  for (const senderUserId of senderUserIds ?? []) {
    const normalized = senderUserId.trim();
    if (normalized) normalizedSenderIds.add(normalized);
  }
  return (
    normalizedSenderIds.size === 1 && normalizedSenderIds.has(requiredUserId)
  );
}

function normalizePositiveInteger(
  value: number | undefined,
  fallback: number,
): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
    ? value
    : fallback;
}

function normalizeNonNegativeInteger(
  value: number | undefined,
  fallback: number,
): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : fallback;
}
