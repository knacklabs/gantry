import type {
  Job,
  JobExecutionMode,
  JobScheduleType,
} from '../../domain/types.js';
import { ApplicationError } from '../common/application-error.js';
import type { Clock } from '../common/clock.js';
import type {
  JobSchedulePlanner,
  JobUpdatePatch,
} from './job-management-types.js';

const MAX_QUERY_LIMIT = 1_000;

export function normalizeScheduleType(raw: unknown): JobScheduleType {
  if (
    raw === 'cron' ||
    raw === 'interval' ||
    raw === 'once' ||
    raw === 'manual'
  ) {
    return raw;
  }
  throw new ApplicationError('INVALID_SCHEDULE', 'Unsupported schedule type.');
}

export function normalizeExecutionMode(
  executionMode: unknown,
  serialize: unknown,
  fallback: JobExecutionMode = 'parallel',
): JobExecutionMode {
  if (executionMode === 'serialized') return 'serialized';
  if (executionMode === 'parallel') return 'parallel';
  if (typeof serialize === 'boolean')
    return serialize ? 'serialized' : 'parallel';
  return fallback;
}

export function resolveLimit(raw: unknown, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  const normalized = Math.floor(raw);
  if (normalized <= 0) return fallback;
  return Math.min(normalized, MAX_QUERY_LIMIT);
}

export function buildJobUpdates(
  job: Job,
  patch: JobUpdatePatch,
  planner: JobSchedulePlanner,
  clock: Clock,
): Partial<Job> {
  const updates: Partial<Job> = {};
  if (patch.name !== undefined)
    updates.name = requireNonEmpty(patch.name, 'name');
  if (patch.prompt !== undefined) {
    updates.prompt = requireNonEmpty(patch.prompt, 'prompt');
  }
  if (patch.model !== undefined) updates.model = patch.model;
  if (patch.groupScope !== undefined) {
    updates.group_scope = requireNonEmpty(patch.groupScope, 'groupScope');
  }
  if (patch.threadId !== undefined) {
    updates.thread_id = patch.threadId
      ? requireNonEmpty(patch.threadId, 'threadId')
      : null;
  }
  if (patch.linkedSessions !== undefined) {
    updates.linked_sessions = patch.linkedSessions.map(String);
  }
  if (patch.executionMode !== undefined)
    updates.execution_mode = patch.executionMode;
  if (patch.silent !== undefined) updates.silent = patch.silent;
  if (patch.cleanupAfterMs !== undefined)
    updates.cleanup_after_ms = patch.cleanupAfterMs;
  if (patch.timeoutMs !== undefined) updates.timeout_ms = patch.timeoutMs;
  if (patch.maxRetries !== undefined) updates.max_retries = patch.maxRetries;
  if (patch.retryBackoffMs !== undefined)
    updates.retry_backoff_ms = patch.retryBackoffMs;
  if (patch.maxConsecutiveFailures !== undefined) {
    updates.max_consecutive_failures = patch.maxConsecutiveFailures;
  }
  if (patch.scheduleType !== undefined)
    updates.schedule_type = patch.scheduleType;
  if (patch.scheduleValue !== undefined)
    updates.schedule_value = patch.scheduleValue;
  const merged = { ...job, ...updates };
  if (
    updates.schedule_type !== undefined ||
    updates.schedule_value !== undefined
  ) {
    if (merged.schedule_type === 'manual') {
      updates.next_run = null;
    } else {
      updates.next_run = planner.planInitial({
        scheduleType: merged.schedule_type,
        scheduleValue: merged.schedule_value,
      }).nextRun;
    }
  }
  if (patch.status === 'paused') {
    updates.status = 'paused';
    updates.pause_reason = 'Paused by SDK';
    updates.next_run = null;
  } else if (patch.status === 'active') {
    const nextRun = planner.planResume({ job: merged, clock });
    if (nextRun === undefined) {
      throw new ApplicationError(
        'INVALID_SCHEDULE',
        'Cannot resume scheduler job due to invalid schedule.',
      );
    }
    updates.status = 'active';
    updates.pause_reason = null;
    updates.next_run = nextRun;
  }
  return updates;
}

export function encodeTriggerRequester(input: {
  appId: string;
  sessionId: string;
}): string {
  return JSON.stringify({
    kind: 'sdk',
    appId: input.appId,
    sessionId: input.sessionId,
  });
}

function requireNonEmpty(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ApplicationError('INVALID_REQUEST', `${field} cannot be empty`);
  }
  return trimmed;
}
