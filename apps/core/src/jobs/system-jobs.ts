import { createHash } from 'node:crypto';

import {
  MEMORY_BACKFILL_CRON,
  MEMORY_BACKFILL_ENABLED,
  MEMORY_BACKFILL_MAX_ITEMS_PER_RUN,
  MEMORY_BACKFILL_MODE,
  MEMORY_BACKFILL_PROVIDER_BATCH_MIN_ITEMS,
  MEMORY_DREAMING_CRON,
  MEMORY_EMBED_BATCH_SIZE,
  MEMORY_EMBED_DIMENSIONS,
  MEMORY_EMBED_MODEL,
  MEMORY_EMBED_PROVIDER,
  OPENAI_DAILY_EMBED_LIMIT,
  RUNTIME_MEMORY_DREAMING_ENABLED,
} from '../config/index.js';
import type { AppId } from '../domain/app/app.js';
import type { Job } from '../domain/types.js';
import { createRuntimeBrainService } from '../brain/brain-runtime.js';
import { runBrainEmbeddingBackfill } from '../brain/brain-embedding-backfill.js';
import {
  getMemoryMaintenanceQueue,
  type MemoryMaintenanceQueueEnqueueResult,
} from '../memory/maintenance-queue.js';
import { runEmbeddingBackfill } from '../memory/app-memory-backfill.js';
import { pollAndImportProviderBatches } from '../memory/app-memory-backfill-provider-batch.js';
import { createEmbeddingProvider } from '../memory/memory-embeddings.js';
import type {
  DreamingRunStatus,
  NormalizedMemorySubject,
} from '../memory/memory-types.js';
import {
  DEFAULT_MEMORY_APP_ID,
  memoryAgentIdForWorkspaceFolder,
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
import {
  MEMORY_DREAM_SYSTEM_PROMPT,
  MEMORY_DREAMING_JOB_ID_PREFIX,
  MEMORY_EMBEDDING_BACKFILL_JOB_ID,
  MEMORY_EMBEDDING_BACKFILL_SYSTEM_PROMPT,
  BRAIN_EMBEDDING_BACKFILL_JOB_ID,
  BRAIN_EMBEDDING_BACKFILL_SYSTEM_PROMPT,
} from '../shared/system-job-identity.js';
import { computeNextJobRun } from './schedule-math.js';
import { buildCanonicalJobLifecycleTarget } from './job-notification-routes.js';
import type { SchedulerDependencies } from './types.js';

export {
  MEMORY_DREAM_SYSTEM_PROMPT,
  MEMORY_EMBEDDING_BACKFILL_SYSTEM_PROMPT,
  BRAIN_EMBEDDING_BACKFILL_SYSTEM_PROMPT,
} from '../shared/system-job-identity.js';
const MEMORY_EMBEDDING_BACKFILL_TIMEOUT_MS = 10 * 60 * 1000;
const MEMORY_REVIEW_NOTIFICATION_LOOKUP_TIMEOUT_MS = 2_000;

function embeddingBackfillEnabled(): boolean {
  return MEMORY_BACKFILL_ENABLED && MEMORY_EMBED_PROVIDER !== 'disabled';
}

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
  return `${MEMORY_DREAMING_JOB_ID_PREFIX}${input.folder}:${routeDigest(input.jid)}`;
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
  const desiredDreamingJobIds = new Set(
    RUNTIME_MEMORY_DREAMING_ENABLED
      ? registrations.map(({ jid, group }) =>
          systemDreamingJobId({ folder: group.folder, jid }),
        )
      : [],
  );
  await deleteObsoleteSystemDreamingJobs(
    deps.opsRepository,
    desiredDreamingJobIds,
  );

  const registrationSignature = JSON.stringify({
    dreamingEnabled: RUNTIME_MEMORY_DREAMING_ENABLED,
    dreamingCron: MEMORY_DREAMING_CRON,
    dreamingTimeoutMs: MEMORY_DREAM_SYSTEM_JOB_TIMEOUT_MS,
    backfillEnabled: embeddingBackfillEnabled(),
    brainBackfillEnabled: embeddingBackfillEnabled(),
    backfillCron: MEMORY_BACKFILL_CRON,
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
        workspaceKey: group.folder,
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
        workspace_key: group.folder,
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

  // One app-wide embedding backfill job (not per conversation). It routes
  // lifecycle/notifications through the primary conversation when available.
  const primary = registrations[0];
  if (embeddingBackfillEnabled() && primary) {
    const existing = await deps.opsRepository.getJobById(
      MEMORY_EMBEDDING_BACKFILL_JOB_ID,
    );
    if (existing?.status !== 'dead_lettered') {
      const computedNextRun = computeNextJobRun(
        { schedule_type: 'cron', schedule_value: MEMORY_BACKFILL_CRON },
        nowIso,
      );
      const target = buildCanonicalJobLifecycleTarget({
        conversationJid: primary.jid,
        workspaceKey: primary.group.folder,
        threadId: null,
        label: 'primary',
      });
      const backfillJob = {
        id: MEMORY_EMBEDDING_BACKFILL_JOB_ID,
        name: 'Memory Embedding Backfill',
        prompt: MEMORY_EMBEDDING_BACKFILL_SYSTEM_PROMPT,
        schedule_type: 'cron',
        schedule_value: MEMORY_BACKFILL_CRON,
        session_id: null,
        workspace_key: primary.group.folder,
        created_by: 'agent',
        status: existing?.status === 'paused' ? 'paused' : 'active',
        next_run: existing?.next_run || computedNextRun,
        silent: true,
        timeout_ms: MEMORY_EMBEDDING_BACKFILL_TIMEOUT_MS,
        max_retries: 1,
        retry_backoff_ms: 30_000,
        max_consecutive_failures: 3,
        execution_context: target.executionContext,
        notification_routes: target.notificationRoutes,
      };
      await deps.opsRepository.upsertJob(
        backfillJob as unknown as Parameters<
          SchedulerDependencies['opsRepository']['upsertJob']
        >[0],
      );
    }

    const existingBrain = await deps.opsRepository.getJobById(
      BRAIN_EMBEDDING_BACKFILL_JOB_ID,
    );
    if (existingBrain?.status !== 'dead_lettered') {
      const computedNextRun = computeNextJobRun(
        { schedule_type: 'cron', schedule_value: MEMORY_BACKFILL_CRON },
        nowIso,
      );
      const target = buildCanonicalJobLifecycleTarget({
        conversationJid: primary.jid,
        workspaceKey: primary.group.folder,
        threadId: null,
        label: 'primary',
      });
      const brainBackfillJob = {
        id: BRAIN_EMBEDDING_BACKFILL_JOB_ID,
        name: 'Brain Embedding Backfill',
        prompt: BRAIN_EMBEDDING_BACKFILL_SYSTEM_PROMPT,
        schedule_type: 'cron',
        schedule_value: MEMORY_BACKFILL_CRON,
        session_id: null,
        workspace_key: primary.group.folder,
        created_by: 'agent',
        status: existingBrain?.status === 'paused' ? 'paused' : 'active',
        next_run: existingBrain?.next_run || computedNextRun,
        silent: true,
        timeout_ms: MEMORY_EMBEDDING_BACKFILL_TIMEOUT_MS,
        max_retries: 1,
        retry_backoff_ms: 30_000,
        max_consecutive_failures: 3,
        execution_context: target.executionContext,
        notification_routes: target.notificationRoutes,
      };
      await deps.opsRepository.upsertJob(
        brainBackfillJob as unknown as Parameters<
          SchedulerDependencies['opsRepository']['upsertJob']
        >[0],
      );
    }
  }
  setSystemJobRegistrationSignature(deps.opsRepository, registrationSignature);
}

async function deleteObsoleteSystemDreamingJobs(
  opsRepository: SchedulerDependencies['opsRepository'],
  desiredJobIds: ReadonlySet<string>,
): Promise<void> {
  const jobs = await opsRepository.getAllJobs();
  for (const job of jobs) {
    if (
      job.id.startsWith(MEMORY_DREAMING_JOB_ID_PREFIX) &&
      !desiredJobIds.has(job.id) &&
      !hasUnsettledJobLease(job)
    ) {
      await opsRepository.deleteJob(job.id);
    }
  }
}

function hasUnsettledJobLease(job: Job): boolean {
  return Boolean(job.lease_run_id || job.lease_expires_at);
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
  if (job.prompt === MEMORY_EMBEDDING_BACKFILL_SYSTEM_PROMPT) {
    return runScheduledEmbeddingBackfill(options.signal);
  }
  if (job.prompt === BRAIN_EMBEDDING_BACKFILL_SYSTEM_PROMPT) {
    return runScheduledBrainEmbeddingBackfill(options.signal);
  }
  if (job.prompt === MEMORY_DREAM_SYSTEM_PROMPT) {
    options.signal?.throwIfAborted();
    const defaultScope = context.conversationKind === 'dm' ? 'user' : 'group';
    const { subject } = resolveScopedMemorySubject({
      appId: DEFAULT_MEMORY_APP_ID,
      agentId: memoryAgentIdForWorkspaceFolder(context.folder),
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

async function runScheduledBrainEmbeddingBackfill(
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  if (!embeddingBackfillEnabled()) {
    return 'Brain embedding backfill is disabled.';
  }
  return runBrainEmbeddingBackfill({
    brain: createRuntimeBrainService(DEFAULT_MEMORY_APP_ID),
    appId: DEFAULT_MEMORY_APP_ID,
    limit: MEMORY_BACKFILL_MAX_ITEMS_PER_RUN,
    signal,
  });
}

async function runScheduledEmbeddingBackfill(
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  if (!embeddingBackfillEnabled()) {
    return 'Memory embedding backfill is disabled.';
  }
  const memory = AppMemoryService.getInstance();
  const db = memory.db;
  const provider = createEmbeddingProvider(MEMORY_EMBED_PROVIDER, {
    model: MEMORY_EMBED_MODEL,
    dimensions: MEMORY_EMBED_DIMENSIONS,
    appId: DEFAULT_MEMORY_APP_ID as AppId,
  });
  // Import any completed provider batches before scanning for new work.
  const poll = await pollAndImportProviderBatches({
    db,
    provider,
    providerName: MEMORY_EMBED_PROVIDER,
    model: MEMORY_EMBED_MODEL,
    signal,
  });
  const pollNote =
    poll.batchesPolled > 0
      ? ` Polled ${poll.batchesPolled} provider batch(es): ${poll.imported} imported, ${poll.retried} retried, ${poll.blocked} blocked, ${poll.stale} stale, ${poll.stillPending} pending, ${poll.deferred} deferred.`
      : '';
  const result = await runEmbeddingBackfill({
    db,
    appId: DEFAULT_MEMORY_APP_ID,
    trigger: 'schedule',
    provider: MEMORY_EMBED_PROVIDER,
    model: MEMORY_EMBED_MODEL,
    dimensions: MEMORY_EMBED_DIMENSIONS,
    batchSize: MEMORY_EMBED_BATCH_SIZE,
    dailyLimit: OPENAI_DAILY_EMBED_LIMIT,
    maxItemsPerRun: MEMORY_BACKFILL_MAX_ITEMS_PER_RUN,
    providerBatchMinItems: MEMORY_BACKFILL_PROVIDER_BATCH_MIN_ITEMS,
    mode: MEMORY_BACKFILL_MODE,
    embeddingProvider: provider,
    signal,
  });
  if (result.pausedByPriorRun) {
    return `Memory embedding backfill paused: ${result.pauseReason ?? 'waiting for resume time'}.${pollNote}`;
  }
  if (result.alreadyRunning) {
    return `Memory embedding backfill skipped: another run is already in progress.${pollNote}`;
  }
  if (result.mode === 'provider_batch' && result.submitted > 0) {
    return `Memory embedding batch submitted: ${result.submitted} items queued.${pollNote}`;
  }
  return `Memory embedding backfill ${result.status}: ${result.indexed} indexed, ${result.pending} pending.${pollNote}`;
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
  const needsReview = numericSummaryValue(run.summary, 'needsReview') ?? 0;
  const pendingReviews =
    numericSummaryValue(run.summary, 'pendingReviews') ?? needsReview;
  const blocked = numericSummaryValue(run.summary, 'blocked') ?? 0;
  const issues: string[] = [];
  if (needsReview > 0) issues.push(`${needsReview} sent to review`);
  if (pendingReviews > needsReview) {
    issues.push(pendingMemoryReviewNotice(pendingReviews));
  }
  if (blocked > 0) issues.push(`${blocked} blocked`);
  if (issues.length > 0) {
    return `Memory dreaming needs attention: ${issues.join(', ')}.`;
  }
  return 'Memory dreaming completed.';
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
