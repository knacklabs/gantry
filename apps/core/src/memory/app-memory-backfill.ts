import { randomUUID } from 'node:crypto';

import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import * as pgSchema from '../adapters/storage/postgres/schema/schema.js';
import type { MemoryBackfillMode } from '../config/settings/runtime-settings-types.js';
import { logger } from '../infrastructure/logging/logger.js';
import { nowIso } from './app-memory-service-query-helpers.js';
import {
  PROCESSING_LEASE_MS,
  selectBackfillCandidates,
  type BackfillCandidate,
} from './app-memory-backfill-candidates.js';
import {
  createBackfillRun,
  finalizeBackfillRun,
  getActiveBackfillPause,
  type BackfillRunCounts,
  type BackfillRunStatus,
} from './app-memory-backfill-runs.js';
import {
  markEmbeddingState,
  writeReadyEmbedding,
  type EmbeddingRowKey,
} from './app-memory-embedding-writes.js';
import {
  EmbeddingProviderError,
  classifyEmbeddingThrown,
  pauseReasonForEmbeddingError,
  type EmbeddingErrorCode,
  type EmbeddingPauseReason,
} from './memory-embedding-errors.js';
import { isUniqueViolation } from './app-memory-service-helpers.js';
import type { EmbeddingProvider } from './memory-embeddings.js';
import {
  submitProviderEmbeddingBatch,
  supportsProviderBatch,
} from './app-memory-backfill-provider-batch.js';

type Db = NodePgDatabase<typeof pgSchema>;

/** Upper bound on active items scanned per run; truncation is logged. */
const SCAN_CEILING = 5000;
const QUOTA_BACKOFF_MS = 60 * 60 * 1000;
const RETRYABLE_BACKOFF_MS = 5 * 60 * 1000;
const RATE_LIMIT_DEFAULT_BACKOFF_MS = 60 * 1000;

export interface RunBackfillInput {
  db: Db;
  appId: string;
  agentId?: string | null;
  trigger: 'cli' | 'schedule';
  provider: string;
  model: string;
  dimensions: number;
  batchSize: number;
  dailyLimit: number;
  maxItemsPerRun: number;
  providerBatchMinItems: number;
  mode: MemoryBackfillMode;
  limit?: number;
  embeddingProvider: EmbeddingProvider;
  signal?: AbortSignal;
  now?: () => string;
}

export interface BackfillResult {
  runId: string;
  status: BackfillRunStatus;
  mode: 'inline' | 'provider_batch';
  totalCandidates: number;
  indexed: number;
  skippedReady: number;
  pending: number;
  submitted: number;
  pauseReason?: EmbeddingPauseReason;
  errorCode?: EmbeddingErrorCode;
  errorMessage?: string;
  alreadyRunning?: boolean;
  pausedByPriorRun?: boolean;
  scanTruncated: boolean;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

function backoffMsFor(error: EmbeddingProviderError): number {
  switch (error.code) {
    case 'rate_limit':
      return error.retryAfterMs ?? RATE_LIMIT_DEFAULT_BACKOFF_MS;
    case 'provider_quota':
      return QUOTA_BACKOFF_MS;
    default:
      return RETRYABLE_BACKOFF_MS;
  }
}

function resumeAfterIso(now: string, ms: number): string {
  return new Date(Date.parse(now) + ms).toISOString();
}

function resolvedRunMode(mode: string): 'inline' | 'provider_batch' {
  return mode === 'provider_batch' ? 'provider_batch' : 'inline';
}

function priorPauseStillApplies(
  run: { pauseReason: string | null; readyCount: number },
  input: RunBackfillInput,
): boolean {
  if (run.pauseReason !== 'paused_daily_budget') return true;
  if (input.dailyLimit <= 0) return false;
  return input.dailyLimit <= Number(run.readyCount ?? 0);
}

function keyFor(
  input: RunBackfillInput,
  candidate: BackfillCandidate,
): EmbeddingRowKey {
  return {
    itemId: candidate.itemId,
    provider: input.provider,
    model: input.model,
    dimensions: input.dimensions,
    contentHash: candidate.contentHash,
  };
}

/**
 * Run (or resume) an embedding backfill for an app/agent scope. Inline mode
 * embeds in chunks and pauses resumably on quota/budget/rate-limit/retryable
 * errors; provider_batch mode submits an async provider batch that scheduled
 * polling later imports. Returns a structured outcome for CLI/status surfaces.
 */
export async function runEmbeddingBackfill(
  input: RunBackfillInput,
): Promise<BackfillResult> {
  const now = input.now ?? nowIso;
  if (input.provider === 'disabled') {
    throw new EmbeddingProviderError(
      'invalid_config',
      'memory embeddings are disabled in runtime settings',
    );
  }
  input.embeddingProvider.validateConfiguration();

  const requested = Math.max(1, input.limit ?? input.maxItemsPerRun);
  const dailyCap = input.dailyLimit > 0 ? input.dailyLimit : Infinity;
  const runCap = Math.min(requested, dailyCap);

  const startedAt = now();
  const activePause = await getActiveBackfillPause(input.db, {
    appId: input.appId,
    agentId: input.agentId ?? null,
    provider: input.provider,
    model: input.model,
    dimensions: input.dimensions,
    now: startedAt,
  });
  if (activePause && priorPauseStillApplies(activePause, input)) {
    return {
      runId: activePause.id,
      status: 'paused',
      mode: resolvedRunMode(activePause.mode),
      totalCandidates: activePause.totalCandidates,
      indexed: activePause.readyCount,
      skippedReady: activePause.skippedReadyCount,
      pending: Math.max(
        0,
        activePause.totalCandidates -
          activePause.readyCount -
          activePause.blockedCount,
      ),
      submitted: 0,
      pauseReason: activePause.pauseReason as EmbeddingPauseReason,
      ...(activePause.lastErrorCode
        ? { errorCode: activePause.lastErrorCode as EmbeddingErrorCode }
        : {}),
      ...(activePause.lastErrorMessage
        ? { errorMessage: activePause.lastErrorMessage }
        : {}),
      alreadyRunning: true,
      pausedByPriorRun: true,
      scanTruncated: false,
    };
  }
  const scan = await selectBackfillCandidates(input.db, {
    appId: input.appId,
    agentId: input.agentId ?? null,
    provider: input.provider,
    model: input.model,
    dimensions: input.dimensions,
    scanLimit: SCAN_CEILING,
    now: startedAt,
    processingLeaseMs: PROCESSING_LEASE_MS,
  });
  const scanTruncated = scan.scanned >= SCAN_CEILING;
  if (scanTruncated) {
    logger.warn(
      { appId: input.appId, scanned: scan.scanned, ceiling: SCAN_CEILING },
      'memory embedding backfill scan hit ceiling; remaining items deferred to a later run',
    );
  }

  const candidates = scan.candidates;
  const runId = randomUUID();
  const resolvedMode = resolveMode(input, candidates.length);
  try {
    await createBackfillRun(input.db, {
      id: runId,
      appId: input.appId,
      agentId: input.agentId ?? null,
      provider: input.provider,
      model: input.model,
      dimensions: input.dimensions,
      trigger: input.trigger,
      mode: resolvedMode,
      totalCandidates: candidates.length,
      now: startedAt,
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      // Another inline backfill is already running for this scope.
      return {
        runId: '',
        status: 'running',
        mode: resolvedMode,
        totalCandidates: candidates.length,
        indexed: 0,
        skippedReady: scan.skippedReady,
        pending: candidates.length,
        submitted: 0,
        alreadyRunning: true,
        scanTruncated,
      };
    }
    throw error;
  }

  if (resolvedMode === 'provider_batch') {
    return runProviderBatch(input, {
      runId,
      candidates: candidates.slice(0, runCap),
      skippedReady: scan.skippedReady,
      totalCandidates: candidates.length,
      scanTruncated,
      now,
    });
  }

  return runInline(input, {
    runId,
    candidates: candidates.slice(0, runCap),
    skippedReady: scan.skippedReady,
    totalCandidates: candidates.length,
    runCap,
    dailyCap,
    scanTruncated,
    now,
  });
}

function resolveMode(
  input: RunBackfillInput,
  pendingCount: number,
): 'inline' | 'provider_batch' {
  if (input.mode === 'inline') return 'inline';
  const batchCapable = supportsProviderBatch(input.embeddingProvider);
  if (input.mode === 'provider_batch') {
    if (!batchCapable) {
      throw new EmbeddingProviderError(
        'invalid_config',
        `provider "${input.provider}" does not support async embedding batches`,
      );
    }
    return 'provider_batch';
  }
  // auto
  if (batchCapable && pendingCount >= input.providerBatchMinItems) {
    return 'provider_batch';
  }
  return 'inline';
}

async function runInline(
  input: RunBackfillInput,
  ctx: {
    runId: string;
    candidates: BackfillCandidate[];
    skippedReady: number;
    totalCandidates: number;
    runCap: number;
    dailyCap: number;
    scanTruncated: boolean;
    now: () => string;
  },
): Promise<BackfillResult> {
  const { runId, candidates, now } = ctx;
  let indexed = 0;
  let retryable = 0;
  let blocked = 0;
  let stale = 0;
  let pauseReason: EmbeddingPauseReason | undefined;
  let pauseResumeAfter: string | null = null;
  let errorCode: EmbeddingErrorCode | undefined;
  let errorMessage: string | undefined;

  for (const group of chunk(candidates, Math.max(1, input.batchSize))) {
    input.signal?.throwIfAborted();
    const stamp = now();
    await Promise.all(
      group.map((candidate) =>
        markEmbeddingState(
          input.db,
          keyFor(input, candidate),
          'processing',
          stamp,
          {
            runId,
            incrementAttempt: true,
            touchAttempt: true,
          },
        ),
      ),
    );

    let vectors: number[][];
    try {
      vectors = await input.embeddingProvider.embedMany(
        group.map((candidate) => candidate.text),
        { signal: input.signal },
      );
    } catch (error) {
      if (input.signal?.aborted) throw error;
      const providerError =
        error instanceof EmbeddingProviderError
          ? error
          : classifyEmbeddingThrown(error);
      const failStamp = now();
      if (providerError.code === 'invalid_dimension') {
        await Promise.all(
          group.map((candidate) =>
            markEmbeddingState(
              input.db,
              keyFor(input, candidate),
              'blocked_invalid_dimension',
              failStamp,
              { runId, error: providerError.message },
            ),
          ),
        );
        blocked += group.length;
        errorCode = providerError.code;
        errorMessage = providerError.message;
        break;
      }
      const reason = pauseReasonForEmbeddingError(providerError);
      if (!reason) {
        // invalid_config or other fatal: release the chunk so it is not stuck.
        await Promise.all(
          group.map((candidate) =>
            markEmbeddingState(
              input.db,
              keyFor(input, candidate),
              'retryable_error',
              failStamp,
              {
                runId,
                error: providerError.message,
                resumeAfter: resumeAfterIso(failStamp, RETRYABLE_BACKOFF_MS),
              },
            ),
          ),
        );
        retryable += group.length;
        errorCode = providerError.code;
        errorMessage = providerError.message;
        break;
      }
      const resumeAfter = resumeAfterIso(
        failStamp,
        backoffMsFor(providerError),
      );
      pauseResumeAfter = resumeAfter;
      await Promise.all(
        group.map((candidate) =>
          markEmbeddingState(
            input.db,
            keyFor(input, candidate),
            'retryable_error',
            failStamp,
            { runId, error: providerError.message, resumeAfter },
          ),
        ),
      );
      retryable += group.length;
      pauseReason = reason;
      errorCode = providerError.code;
      errorMessage = providerError.message;
      break;
    }

    const writeStamp = now();
    for (let i = 0; i < group.length; i += 1) {
      const candidate = group[i]!;
      const vector = vectors[i];
      if (!vector) {
        await markEmbeddingState(
          input.db,
          keyFor(input, candidate),
          'retryable_error',
          writeStamp,
          {
            runId,
            error: 'provider returned no vector for item',
            resumeAfter: resumeAfterIso(writeStamp, RETRYABLE_BACKOFF_MS),
          },
        );
        retryable += 1;
        continue;
      }
      const stored = await writeReadyEmbedding(
        input.db,
        keyFor(input, candidate),
        vector,
        writeStamp,
        runId,
      );
      if (stored) {
        indexed += 1;
      } else {
        stale += 1;
      }
    }

    if (Number.isFinite(ctx.dailyCap) && indexed >= ctx.dailyCap) {
      break;
    }
  }

  const processed = indexed + retryable + blocked + stale;
  const pending = Math.max(0, ctx.totalCandidates - indexed - blocked - stale);
  let status: BackfillRunStatus;
  if (errorCode === 'invalid_dimension' || errorCode === 'invalid_config') {
    status = 'failed';
  } else if (pauseReason) {
    status = 'paused';
  } else if (
    Number.isFinite(ctx.dailyCap) &&
    indexed >= ctx.dailyCap &&
    pending > 0
  ) {
    status = 'paused';
    pauseReason = 'paused_daily_budget';
  } else {
    status = 'completed';
  }

  const counts: BackfillRunCounts = {
    totalCandidates: ctx.totalCandidates,
    processedCount: processed,
    readyCount: indexed,
    skippedReadyCount: ctx.skippedReady,
    retryableCount: retryable,
    blockedCount: blocked,
  };
  const finalNow = now();
  await finalizeBackfillRun(input.db, runId, {
    status,
    counts,
    mode: 'inline',
    pauseReason: pauseReason ?? null,
    lastErrorCode: errorCode ?? null,
    lastErrorMessage: errorMessage ?? null,
    resumeAfter:
      status === 'paused'
        ? (pauseResumeAfter ??
          resumeAfterIso(
            finalNow,
            pauseReason === 'paused_daily_budget'
              ? 24 * 60 * 60 * 1000
              : RETRYABLE_BACKOFF_MS,
          ))
        : null,
    now: finalNow,
  });

  return {
    runId,
    status,
    mode: 'inline',
    totalCandidates: ctx.totalCandidates,
    indexed,
    skippedReady: ctx.skippedReady,
    pending,
    submitted: 0,
    ...(pauseReason ? { pauseReason } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    scanTruncated: ctx.scanTruncated,
  };
}

async function runProviderBatch(
  input: RunBackfillInput,
  ctx: {
    runId: string;
    candidates: BackfillCandidate[];
    skippedReady: number;
    totalCandidates: number;
    scanTruncated: boolean;
    now: () => string;
  },
): Promise<BackfillResult> {
  const { runId, candidates, now } = ctx;
  let submitted = 0;
  let status: BackfillRunStatus = 'running';
  let errorCode: EmbeddingErrorCode | undefined;
  let errorMessage: string | undefined;
  let pauseReason: EmbeddingPauseReason | undefined;
  let pauseResumeAfter: string | null = null;

  try {
    submitted = await submitProviderEmbeddingBatch({
      db: input.db,
      provider: input.embeddingProvider,
      providerName: input.provider,
      model: input.model,
      dimensions: input.dimensions,
      runId,
      candidates,
      now,
      signal: input.signal,
    });
  } catch (error) {
    if (input.signal?.aborted) throw error;
    const providerError =
      error instanceof EmbeddingProviderError
        ? error
        : classifyEmbeddingThrown(error);
    errorCode = providerError.code;
    errorMessage = providerError.message;
    pauseReason = pauseReasonForEmbeddingError(providerError) ?? undefined;
    status = pauseReason ? 'paused' : 'failed';
    if (pauseReason) {
      pauseResumeAfter = resumeAfterIso(now(), backoffMsFor(providerError));
    }
  }

  const finalNow = now();
  const counts: BackfillRunCounts = {
    totalCandidates: ctx.totalCandidates,
    processedCount: submitted,
    readyCount: 0,
    skippedReadyCount: ctx.skippedReady,
    retryableCount: status === 'paused' ? candidates.length : 0,
    blockedCount: 0,
  };
  await finalizeBackfillRun(input.db, runId, {
    status,
    counts,
    mode: 'provider_batch',
    pauseReason: pauseReason ?? null,
    lastErrorCode: errorCode ?? null,
    lastErrorMessage: errorMessage ?? null,
    resumeAfter: status === 'paused' ? pauseResumeAfter : null,
    now: finalNow,
  });

  return {
    runId,
    status,
    mode: 'provider_batch',
    totalCandidates: ctx.totalCandidates,
    indexed: 0,
    skippedReady: ctx.skippedReady,
    pending: Math.max(0, ctx.totalCandidates - submitted),
    submitted,
    ...(pauseReason ? { pauseReason } : {}),
    ...(errorCode ? { errorCode } : {}),
    ...(errorMessage ? { errorMessage } : {}),
    scanTruncated: ctx.scanTruncated,
  };
}
