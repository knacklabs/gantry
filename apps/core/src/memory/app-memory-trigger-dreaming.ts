import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, isNull, or, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { AppId } from '../domain/app/app.js';

import {
  MEMORY_DREAMING_EMBED_MODEL,
  MEMORY_DREAMING_EMBED_PROVIDER,
  MEMORY_DREAMING_EMBEDDINGS_ENABLED,
  RUNTIME_MEMORY_DREAMING_ENABLED,
} from '../config/memory.js';
import * as pgSchema from '../adapters/storage/postgres/schema/schema.js';
import { ApplicationError } from '../application/common/application-error.js';
import {
  abortReason,
  createMemoryOperationDeadline,
  isMemoryOperationTimeoutError,
  normalizeMemoryTimeoutMs,
} from '../shared/memory-dreaming-timeout.js';
import { runAppMemoryDreamPass } from './app-memory-dreaming.js';
import { normalizeSubject } from './app-memory-boundaries.js';
import {
  DREAM_EMBEDDING_DEADLINE_MS,
  runWithTimeout,
  storeDreamItemEmbedding,
} from './app-memory-dream-embeddings.js';
import { createEmbeddingProvider } from './memory-embeddings.js';
import { queryAppMemoryItems } from './app-memory-recall.js';
import { toRun } from './app-memory-service-record-mappers.js';
import { summarizeDreamDecisions } from './app-memory-service-dreaming.js';
import { isUniqueViolation } from './app-memory-service-helpers.js';
import { nowIso } from './app-memory-service-query-helpers.js';
import {
  MEMORY_REVIEW_SUMMARY_STATEMENT_TIMEOUT_MS,
  safeCountPendingMemoryReviews,
  withPendingReviews,
} from './app-memory-dreaming-review-summary.js';
import { createPendingMemoryReview } from './app-memory-review.js';
import {
  proposeMemoryConsolidationActions,
  proposeMemoryDreamingActions,
} from './memory-llm-proposals.js';
import type {
  AppMemoryItem,
  DeleteAppMemoryInput,
  DreamingRunStatus,
  DreamingTriggerInput,
  SaveAppMemoryInput,
} from './memory-types.js';

type Db = NodePgDatabase<typeof pgSchema>;

const APP_MEMORY_TRIGGER_RECALL_DEPS = {
  schema: {
    memoryItemsPostgres: pgSchema.memoryItemsPostgres,
    memoryRecallEventsPostgres: pgSchema.memoryRecallEventsPostgres,
  },
  sqlOps: { and, asc, desc, eq, isNull, or, sql },
} as const;

function boundedRemainingTimeoutMs(
  remainingMs: number | undefined,
  maxMs: number,
): number | undefined {
  if (remainingMs === undefined || !Number.isFinite(remainingMs)) {
    return undefined;
  }
  return Math.max(1, Math.floor(Math.min(remainingMs, maxMs)));
}

export async function triggerAppMemoryDreaming(input: {
  db: Db;
  triggerInput?: DreamingTriggerInput;
  save: (value: SaveAppMemoryInput) => Promise<AppMemoryItem>;
  retire: (value: DeleteAppMemoryInput) => Promise<{ deleted: boolean }>;
}): Promise<DreamingRunStatus> {
  const triggerInput = input.triggerInput ?? {};
  const { db } = input;
  if (!RUNTIME_MEMORY_DREAMING_ENABLED) {
    throw new ApplicationError(
      'CONFLICT',
      'memory dreaming is disabled in runtime settings',
    );
  }
  const deadlineRemainingMs =
    typeof triggerInput.deadlineAtMs === 'number' &&
    Number.isFinite(triggerInput.deadlineAtMs)
      ? triggerInput.deadlineAtMs - Date.now()
      : undefined;
  const requestedTimeoutMs =
    typeof triggerInput.timeoutMs === 'number' &&
    Number.isFinite(triggerInput.timeoutMs) &&
    typeof deadlineRemainingMs === 'number'
      ? Math.min(triggerInput.timeoutMs, deadlineRemainingMs)
      : (triggerInput.timeoutMs ?? deadlineRemainingMs);
  const dreamDeadline = createMemoryOperationDeadline({
    timeoutMs: normalizeMemoryTimeoutMs(
      requestedTimeoutMs,
      pgSchema.MEMORY_DREAM_RUN_TIMEOUT_MS,
    ),
    label: 'memory dreaming',
    parentSignal: triggerInput.signal,
  });
  const subject = normalizeSubject(triggerInput);
  const phase = triggerInput.phase || 'all';
  dreamDeadline.throwIfExpired();
  const now = nowIso();
  const running = await pgSchema.findRunningDreamRun({
    db,
    subject,
    phase,
    now,
  });
  if (running) {
    dreamDeadline.dispose();
    return toRun(running);
  }
  await pgSchema.expireStaleDreamRuns({ db, subject, phase, now });
  const runningAfterExpiry = await pgSchema.findRunningDreamRun({
    db,
    subject,
    phase,
    now,
  });
  if (runningAfterExpiry) {
    dreamDeadline.dispose();
    return toRun(runningAfterExpiry);
  }
  const runId = `mdr_${randomUUID().replace(/-/g, '')}`;
  const finalizeRun = async (
    status: DreamingRunStatus['status'],
    summary: Record<string, unknown>,
  ): Promise<DreamingRunStatus> => {
    const [row] = await db
      .update(pgSchema.memoryDreamRunsPostgres)
      .set({
        status,
        summaryJson: JSON.stringify(summary),
        completedAt: nowIso(),
      })
      .where(eq(pgSchema.memoryDreamRunsPostgres.id, runId))
      .returning();
    return toRun(row!);
  };
  try {
    await db.insert(pgSchema.memoryDreamRunsPostgres).values({
      id: runId,
      appId: subject.appId,
      agentId: subject.agentId,
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
      threadId: null,
      phase,
      status: 'running',
      summaryJson: '{}',
      startedAt: now,
      leaseExpiresAt: pgSchema.dreamRunLeaseExpiresAt(
        now,
        dreamDeadline.deadlineAtMs,
      ),
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      const conflictNow = nowIso();
      await pgSchema.expireStaleDreamRuns({
        db,
        subject,
        phase,
        now: conflictNow,
      });
      const runningAfterConflict = await pgSchema.findRunningDreamRun({
        db,
        subject,
        phase,
        now: conflictNow,
      });
      if (runningAfterConflict) {
        dreamDeadline.dispose();
        return toRun(runningAfterConflict);
      }
    }
    dreamDeadline.dispose();
    throw error;
  }
  const embeddingsEnabled =
    MEMORY_DREAMING_EMBEDDINGS_ENABLED &&
    MEMORY_DREAMING_EMBED_PROVIDER !== 'disabled';
  const embeddingProvider = embeddingsEnabled
    ? createEmbeddingProvider(MEMORY_DREAMING_EMBED_PROVIDER, {
        model: MEMORY_DREAMING_EMBED_MODEL,
        appId: subject.appId as AppId,
      })
    : null;
  if (embeddingProvider) {
    try {
      dreamDeadline.throwIfExpired();
      await runWithTimeout(
        async (signal) => {
          embeddingProvider.validateConfiguration();
          await embeddingProvider.validateReady?.({ signal });
        },
        boundedRemainingTimeoutMs(
          dreamDeadline.remainingTimeoutMs(),
          DREAM_EMBEDDING_DEADLINE_MS,
        ) ?? DREAM_EMBEDDING_DEADLINE_MS,
        { signal: dreamDeadline.signal },
      );
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : 'unknown readiness error';
      const pendingReviews = await safeCountPendingMemoryReviews({
        db,
        subject,
      });
      const run = await finalizeRun(
        'failed',
        withPendingReviews(
          {
            stage: 'embedding_readiness',
            error: reason,
            embeddingsEnabled: true,
            embeddingProvider: MEMORY_DREAMING_EMBED_PROVIDER,
            embeddingModel: MEMORY_DREAMING_EMBED_MODEL,
            dryRun: Boolean(triggerInput.dryRun),
          },
          pendingReviews,
        ),
      );
      const abortError = triggerInput.signal?.aborted
        ? abortReason(triggerInput.signal)
        : dreamDeadline.signal.aborted
          ? abortReason(dreamDeadline.signal)
          : null;
      dreamDeadline.dispose();
      if (abortError) throw abortError;
      return run;
    }
  }
  let decisions: Awaited<ReturnType<typeof runAppMemoryDreamPass>>;
  try {
    decisions = await runAppMemoryDreamPass({
      db,
      runId,
      subject,
      phase,
      dryRun: Boolean(triggerInput.dryRun),
      signal: dreamDeadline.signal,
      remainingTimeoutMs: dreamDeadline.remainingTimeoutMs,
      listItems: () => {
        dreamDeadline.throwIfExpired();
        return queryAppMemoryItems(
          db,
          { ...subject, limit: 100 },
          false,
          APP_MEMORY_TRIGGER_RECALL_DEPS,
          {
            signal: dreamDeadline.signal,
            statementTimeoutMs: boundedRemainingTimeoutMs(
              dreamDeadline.remainingTimeoutMs(),
              30_000,
            ),
          },
        );
      },
      save: input.save,
      retire: input.retire,
      storeDreamEmbedding: async (value) => {
        if (!embeddingProvider) return { status: 'disabled' as const };
        dreamDeadline.throwIfExpired();
        return storeDreamItemEmbedding({
          db,
          now: nowIso,
          provider: embeddingProvider,
          providerName: MEMORY_DREAMING_EMBED_PROVIDER,
          model: MEMORY_DREAMING_EMBED_MODEL,
          ...value,
          timeoutMs:
            boundedRemainingTimeoutMs(
              dreamDeadline.remainingTimeoutMs(),
              DREAM_EMBEDDING_DEADLINE_MS,
            ) ?? DREAM_EMBEDDING_DEADLINE_MS,
          signal: dreamDeadline.signal,
        });
      },
      proposeDreaming: ({ evidence, candidates, activeItems }) =>
        proposeMemoryDreamingActions({
          subject,
          evidence,
          candidates,
          activeItems,
          timeoutMs: boundedRemainingTimeoutMs(
            dreamDeadline.remainingTimeoutMs(),
            120_000,
          ),
          signal: dreamDeadline.signal,
        }),
      proposeConsolidation: ({ activeItems }) =>
        proposeMemoryConsolidationActions({
          subject,
          activeItems,
          timeoutMs: boundedRemainingTimeoutMs(
            dreamDeadline.remainingTimeoutMs(),
            120_000,
          ),
          signal: dreamDeadline.signal,
        }),
      createPendingReview: (proposal, reviewDb = db) =>
        createPendingMemoryReview({
          db: reviewDb,
          runId,
          subject,
          phase,
          proposal,
        }),
    });
    dreamDeadline.throwIfExpired();
    const pendingReviews = await safeCountPendingMemoryReviews({
      db,
      subject,
      signal: dreamDeadline.signal,
      statementTimeoutMs:
        boundedRemainingTimeoutMs(
          dreamDeadline.remainingTimeoutMs(),
          MEMORY_REVIEW_SUMMARY_STATEMENT_TIMEOUT_MS,
        ) ?? MEMORY_REVIEW_SUMMARY_STATEMENT_TIMEOUT_MS,
    });
    dreamDeadline.throwIfExpired();
    const summary = summarizeDreamDecisions(
      decisions,
      Boolean(triggerInput.dryRun),
      {
        pendingReviews,
      },
    );
    const run = await finalizeRun('completed', summary);
    dreamDeadline.dispose();
    return run;
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : 'unknown dreaming error';
    const timedOut =
      isMemoryOperationTimeoutError(error) || dreamDeadline.signal.aborted;
    const pendingReviews = await safeCountPendingMemoryReviews({
      db,
      subject,
    });
    const run = await finalizeRun(
      'failed',
      withPendingReviews(
        {
          stage: timedOut ? 'dreaming_timeout' : 'dreaming_pass',
          error: reason,
          dryRun: Boolean(triggerInput.dryRun),
        },
        pendingReviews,
      ),
    );
    const abortError = triggerInput.signal?.aborted
      ? abortReason(triggerInput.signal)
      : dreamDeadline.signal.aborted
        ? abortReason(dreamDeadline.signal)
        : null;
    dreamDeadline.dispose();
    if (abortError) throw abortError;
    return run;
  }
}
