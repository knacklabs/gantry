import { createHash } from 'node:crypto';

import {
  MEMORY_DREAMING_CRON,
  RUNTIME_MEMORY_DREAMING_ENABLED,
} from '../config/index.js';
import type { Job } from '../domain/types.js';
import {
  getMemoryMaintenanceQueue,
  type MemoryMaintenanceQueueEnqueueResult,
} from '../memory/maintenance-queue.js';
import type {
  DreamingRunStatus,
  NormalizedMemorySubject,
} from '../memory/memory-types.js';
import {
  DEFAULT_MEMORY_APP_ID,
  memoryAgentIdForGroupFolder,
} from '../memory/app-memory-boundaries.js';
import { resolveScopedMemorySubject } from '../memory/app-memory-subject-resolver.js';
import { AppMemoryService } from '../memory/app-memory-service.js';
import {
  createMemoryOperationDeadline,
  MEMORY_DREAM_SYSTEM_JOB_FINALIZATION_GRACE_MS,
  MEMORY_DREAM_SYSTEM_JOB_TIMEOUT_MS,
  normalizeMemoryTimeoutMs,
} from '../shared/memory-dreaming-timeout.js';
import { nowIso as currentIso } from '../shared/time/datetime.js';
import {
  getSystemJobRegistrationSignature,
  setSystemJobRegistrationSignature,
} from './system-registration-cache.js';
import { computeNextJobRun } from './schedule-math.js';
import { buildCanonicalJobLifecycleTarget } from './job-notification-routes.js';
import type { SchedulerDependencies } from './types.js';

export const MEMORY_DREAM_SYSTEM_PROMPT = '__system:memory_dream';
const MEMORY_REVIEW_NOTIFICATION_LOOKUP_TIMEOUT_MS = 2_000;

type MemoryMaintenanceQueueLike = {
  enqueueAndWait: (
    folder: string,
    task: () => Promise<void>,
    dedupeKey?: string,
    options?: { signal?: AbortSignal },
  ) => Promise<MemoryMaintenanceQueueEnqueueResult>;
  getPendingCount: () => number;
};

let memoryMaintenanceQueue: MemoryMaintenanceQueueLike =
  getMemoryMaintenanceQueue();

function routeDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function systemDreamingJobId(input: { folder: string; jid: string }): string {
  return `system:dreaming:${input.folder}:${routeDigest(input.jid)}`;
}

export function memoryDreamingTimeoutForJob(
  jobTimeoutMs: number | null | undefined,
): number {
  const normalizedJobTimeoutMs = normalizeMemoryTimeoutMs(
    jobTimeoutMs,
    MEMORY_DREAM_SYSTEM_JOB_TIMEOUT_MS,
  );
  return Math.max(
    30_000,
    normalizedJobTimeoutMs - MEMORY_DREAM_SYSTEM_JOB_FINALIZATION_GRACE_MS,
  );
}

function pendingMemoryReviewLabel(count: number): string {
  return `${count} pending memory review${count === 1 ? '' : 's'}`;
}

function pendingMemoryReviewNotice(count: number): string {
  return `${pendingMemoryReviewLabel(count)} need${count === 1 ? 's' : ''} review`;
}

async function countPendingReviewsForNotification(input: {
  memory: AppMemoryService;
  subject: NormalizedMemorySubject;
}): Promise<number> {
  try {
    const reviews = await input.memory.listPendingReviews(input.subject, {
      statementTimeoutMs: MEMORY_REVIEW_NOTIFICATION_LOOKUP_TIMEOUT_MS,
    });
    return reviews.length;
  } catch {
    return 0;
  }
}

function appendPendingReviewContextToError(
  error: unknown,
  pendingReviews: number,
): Error {
  if (pendingReviews <= 0) {
    return error instanceof Error ? error : new Error(String(error));
  }
  const baseMessage =
    error instanceof Error ? error.message : String(error || 'unknown error');
  const separator = /[.!?]\s*$/.test(baseMessage) ? ' ' : '. ';
  return new Error(
    `${baseMessage}${separator}${pendingMemoryReviewNotice(pendingReviews)}.`,
  );
}

export async function registerSystemJobs(
  deps: SchedulerDependencies,
): Promise<void> {
  const groups = deps.conversationRoutes();
  const registrations = Object.entries(groups).map(([jid, group]) => ({
    jid,
    group,
  }));

  const registrationSignature = JSON.stringify({
    dreamingEnabled: RUNTIME_MEMORY_DREAMING_ENABLED,
    dreamingCron: MEMORY_DREAMING_CRON,
    dreamingTimeoutMs: MEMORY_DREAM_SYSTEM_JOB_TIMEOUT_MS,
    routes: registrations
      .map(({ jid, group }) => [
        group.folder,
        jid,
        group.conversationKind ?? 'channel',
      ])
      .sort(([leftFolder, leftJid], [rightFolder, rightJid]) =>
        `${leftFolder}:${leftJid}`.localeCompare(`${rightFolder}:${rightJid}`),
      ),
  });
  if (
    getSystemJobRegistrationSignature(deps.opsRepository) ===
    registrationSignature
  ) {
    return;
  }

  const nowIso = currentIso();
  if (RUNTIME_MEMORY_DREAMING_ENABLED) {
    for (const { jid, group } of registrations) {
      const jobId = systemDreamingJobId({ folder: group.folder, jid });
      const existing = await deps.opsRepository.getJobById(jobId);
      if (existing?.status === 'dead_lettered') {
        continue;
      }
      const computedNextRun = computeNextJobRun(
        {
          schedule_type: 'cron',
          schedule_value: MEMORY_DREAMING_CRON,
        },
        nowIso,
      );
      const nextRun = existing?.next_run || computedNextRun;
      const desiredStatus = existing?.status === 'paused' ? 'paused' : 'active';
      const target = buildCanonicalJobLifecycleTarget({
        conversationJid: jid,
        groupScope: group.folder,
        threadId: null,
        label: 'primary',
      });

      const systemJob = {
        id: jobId,
        name: `Memory Dreaming (${group.folder} ${jid})`,
        prompt: MEMORY_DREAM_SYSTEM_PROMPT,
        schedule_type: 'cron',
        schedule_value: MEMORY_DREAMING_CRON,
        session_id: null,
        group_scope: group.folder,
        created_by: 'agent',
        status: desiredStatus,
        next_run: nextRun,
        silent: false,
        timeout_ms: MEMORY_DREAM_SYSTEM_JOB_TIMEOUT_MS,
        max_retries: 1,
        retry_backoff_ms: 30_000,
        max_consecutive_failures: 3,
        execution_context: target.executionContext,
        notification_routes: target.notificationRoutes,
      };
      await deps.opsRepository.upsertJob(
        systemJob as unknown as Parameters<
          SchedulerDependencies['opsRepository']['upsertJob']
        >[0],
      );
    }
  }
  setSystemJobRegistrationSignature(deps.opsRepository, registrationSignature);
}

export async function handleSystemJob(
  job: Job,
  context: {
    folder: string;
    conversationId?: string;
    conversationKind?: 'dm' | 'channel';
    userId?: string;
    threadId?: string | null;
  },
  options: { signal?: AbortSignal; deadlineAtMs?: number } = {},
): Promise<string> {
  if (job.prompt === MEMORY_DREAM_SYSTEM_PROMPT) {
    options.signal?.throwIfAborted();
    const defaultScope = context.conversationKind === 'dm' ? 'user' : 'group';
    const { subject } = resolveScopedMemorySubject({
      appId: DEFAULT_MEMORY_APP_ID,
      agentId: memoryAgentIdForGroupFolder(context.folder),
      groupId: context.folder,
      conversationId: context.conversationId,
      userId: context.userId,
      threadId: context.threadId || undefined,
      defaultScope,
    });
    let dreamRun: DreamingRunStatus | undefined;
    const memory = AppMemoryService.getInstance();
    const jobDeadline = createMemoryOperationDeadline({
      timeoutMs: memoryDreamingTimeoutForJob(job.timeout_ms),
      label: 'memory dreaming job',
      parentSignal: options.signal,
    });
    try {
      const queueResult = await memoryMaintenanceQueue.enqueueAndWait(
        context.folder,
        async () => {
          jobDeadline.throwIfExpired();
          try {
            dreamRun = await memory.triggerDreaming({
              ...subject,
              appId: subject.appId,
              agentId: subject.agentId,
              subjectType: subject.subjectType,
              subjectId: subject.subjectId,
              phase: 'all',
              signal: jobDeadline.signal,
              timeoutMs: normalizeMemoryTimeoutMs(
                jobDeadline.remainingTimeoutMs(),
                memoryDreamingTimeoutForJob(job.timeout_ms),
              ),
              deadlineAtMs: options.deadlineAtMs,
            });
          } catch (error) {
            const pendingReviews = await countPendingReviewsForNotification({
              memory,
              subject,
            });
            throw appendPendingReviewContextToError(error, pendingReviews);
          }
        },
        `dream:${subject.subjectType}:${subject.subjectId}`,
        { signal: jobDeadline.signal },
      );
      if (!queueResult.queued) {
        if (queueResult.reason === 'full') {
          throw new Error('memory maintenance queue full');
        }
        if (queueResult.reason === 'invalid') {
          throw new Error('invalid memory maintenance group');
        }
      }
      return formatMemoryDreamingOutcome(dreamRun, queueResult);
    } finally {
      jobDeadline.dispose();
    }
  }
  throw new Error(`Unknown system job: ${job.prompt}`);
}

function numericSummaryValue(
  summary: unknown,
  key: string,
): number | undefined {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    return undefined;
  }
  const value = (summary as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : undefined;
}

function formatMemoryDreamingOutcome(
  run: DreamingRunStatus | undefined,
  queueResult: MemoryMaintenanceQueueEnqueueResult,
): string {
  if (queueResult.deduped) {
    return 'Memory dreaming was already running for this conversation.';
  }
  if (!run) {
    return 'Memory dreaming completed.';
  }
  if (run.status === 'failed') {
    const summary =
      run.summary && typeof run.summary === 'object'
        ? (run.summary as Record<string, unknown>)
        : {};
    const error = typeof summary.error === 'string' ? summary.error : '';
    const pendingReviews = numericSummaryValue(summary, 'pendingReviews') ?? 0;
    const base = error
      ? `Memory dreaming failed: ${error}${/[.!?]\s*$/.test(error) ? '' : '.'}`
      : 'Memory dreaming failed.';
    return appendPendingReviewNotice(base, pendingReviews);
  }
  const promoted = numericSummaryValue(run.summary, 'promoted') ?? 0;
  const updated = numericSummaryValue(run.summary, 'updated') ?? 0;
  const needsReview = numericSummaryValue(run.summary, 'needsReview') ?? 0;
  const pendingReviews =
    numericSummaryValue(run.summary, 'pendingReviews') ?? needsReview;
  const skipped = numericSummaryValue(run.summary, 'skipped') ?? 0;
  const blocked = numericSummaryValue(run.summary, 'blocked') ?? 0;
  const changes: string[] = [];
  if (promoted > 0) changes.push(`${promoted} promoted`);
  if (updated > 0) changes.push(`${updated} updated`);
  if (needsReview > 0) changes.push(`${needsReview} sent to review`);
  if (changes.length > 0) {
    return appendPendingReviewNotice(
      `Memory dreaming completed: ${changes.join(', ')}.`,
      pendingReviews,
      needsReview,
    );
  }
  if (skipped > 0 || blocked > 0) {
    return appendPendingReviewNotice(
      `Memory dreaming completed with no memory changes; ${skipped} skipped, ${blocked} blocked.`,
      pendingReviews,
    );
  }
  return appendPendingReviewNotice(
    'Memory dreaming completed with no memory changes.',
    pendingReviews,
  );
}

function appendPendingReviewNotice(
  summary: string,
  pendingReviews: number,
  alreadyReported = 0,
) {
  if (pendingReviews <= alreadyReported) return summary;
  return `${summary} ${pendingMemoryReviewNotice(pendingReviews)}.`;
}

export function resetSystemJobStateForTests(): void {
  memoryMaintenanceQueue = getMemoryMaintenanceQueue();
}

export function _setMemoryMaintenanceQueueForTests(queue: unknown): void {
  memoryMaintenanceQueue =
    (queue as MemoryMaintenanceQueueLike | null) ?? getMemoryMaintenanceQueue();
}
