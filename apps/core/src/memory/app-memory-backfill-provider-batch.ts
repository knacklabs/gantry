import { and, asc, eq, isNotNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import * as pgSchema from '../adapters/storage/postgres/schema/schema.js';
import { logger } from '../infrastructure/logging/logger.js';
import { nowIso } from './app-memory-service-query-helpers.js';
import type { BackfillCandidate } from './app-memory-backfill-candidates.js';
import { finalizeBackfillRun } from './app-memory-backfill-runs.js';
import {
  markEmbeddingState,
  writeReadyEmbedding,
  type EmbeddingRowKey,
} from './app-memory-embedding-writes.js';
import type { EmbeddingProvider } from './memory-embeddings.js';

type Db = NodePgDatabase<typeof pgSchema>;
const Embeddings = pgSchema.memoryItemEmbeddingsPostgres;
const Runs = pgSchema.memoryEmbeddingBackfillRunsPostgres;
const IMPORT_RETRY_BACKOFF_MS = 5 * 60 * 1000;
const DEFAULT_MAX_BATCHES_PER_POLL = 10;
const DEFAULT_MAX_ROWS_PER_POLL = 5000;

/** True when a provider can submit async embedding batches (backfill only). */
export function supportsProviderBatch(provider: EmbeddingProvider): boolean {
  return Boolean(provider.batch);
}

/**
 * Submit candidates as one async provider batch and mark their rows `submitted`
 * with the returned provider batch id. Returns the number of items submitted.
 * Live recall never calls this; batches are backfill-only.
 */
export async function submitProviderEmbeddingBatch(input: {
  db: Db;
  provider: EmbeddingProvider;
  providerName: string;
  model: string;
  dimensions: number;
  runId: string;
  candidates: BackfillCandidate[];
  now: () => string;
  signal?: AbortSignal;
}): Promise<number> {
  if (input.candidates.length === 0 || !input.provider.batch) return 0;
  const { batchId } = await input.provider.batch.submitBatch(
    input.candidates.map((candidate) => ({
      customId: candidate.itemId,
      input: candidate.text,
    })),
    { signal: input.signal },
  );
  const stamp = input.now();
  for (const candidate of input.candidates) {
    await markEmbeddingState(
      input.db,
      keyFor(input, candidate.itemId, candidate.contentHash, input.dimensions),
      'submitted',
      stamp,
      {
        runId: input.runId,
        providerBatchId: batchId,
        incrementAttempt: true,
        touchAttempt: true,
      },
    );
  }
  return input.candidates.length;
}

interface SubmittedRow {
  itemId: string;
  contentHash: string;
  dimensions: number;
  runId: string | null;
  providerBatchId: string;
}

export interface ProviderBatchPollSummary {
  batchesPolled: number;
  imported: number;
  retried: number;
  blocked: number;
  stale: number;
  stillPending: number;
  deferred: number;
}

/**
 * Poll every in-flight provider batch for the scope and import completed
 * results: ready vectors are written, dimension mismatches are blocked, and
 * other failures become retryable. Owning backfill runs are then finalized.
 */
export async function pollAndImportProviderBatches(input: {
  db: Db;
  provider: EmbeddingProvider;
  providerName: string;
  model: string;
  now?: () => string;
  signal?: AbortSignal;
  maxBatches?: number;
  maxRows?: number;
}): Promise<ProviderBatchPollSummary> {
  const now = input.now ?? nowIso;
  const maxRows = Math.max(1, input.maxRows ?? DEFAULT_MAX_ROWS_PER_POLL);
  const maxBatches = Math.max(
    1,
    input.maxBatches ?? DEFAULT_MAX_BATCHES_PER_POLL,
  );
  const summary: ProviderBatchPollSummary = {
    batchesPolled: 0,
    imported: 0,
    retried: 0,
    blocked: 0,
    stale: 0,
    stillPending: 0,
    deferred: 0,
  };
  if (!input.provider.batch) return summary;

  const submitted = (await input.db
    .select({
      itemId: Embeddings.itemId,
      contentHash: Embeddings.contentHash,
      dimensions: Embeddings.dimensions,
      runId: Embeddings.runId,
      providerBatchId: Embeddings.providerBatchId,
    })
    .from(Embeddings)
    .where(
      and(
        eq(Embeddings.provider, input.providerName),
        eq(Embeddings.model, input.model),
        eq(Embeddings.status, 'submitted'),
        isNotNull(Embeddings.providerBatchId),
      ),
    )
    .orderBy(
      asc(Embeddings.updatedAt),
      asc(Embeddings.providerBatchId),
      asc(Embeddings.itemId),
    )
    .limit(maxRows)) as SubmittedRow[];

  const byBatch = new Map<string, SubmittedRow[]>();
  for (const row of submitted) {
    const list = byBatch.get(row.providerBatchId) ?? [];
    list.push(row);
    byBatch.set(row.providerBatchId, list);
  }

  const affectedRunIds = new Set<string>();
  const batches = [...byBatch.entries()];
  for (const [, rows] of batches.slice(maxBatches)) {
    summary.deferred += rows.length;
  }

  for (const [batchId, rows] of batches.slice(0, maxBatches)) {
    input.signal?.throwIfAborted();
    summary.batchesPolled += 1;
    let poll;
    try {
      poll = await input.provider.batch.pollBatch(batchId, {
        signal: input.signal,
      });
    } catch (error) {
      logger.warn(
        { batchId, err: error },
        'failed to poll provider embedding batch; will retry next run',
      );
      summary.stillPending += rows.length;
      continue;
    }
    if (poll.state === 'pending') {
      summary.stillPending += rows.length;
      continue;
    }

    const results = await input.provider.batch.fetchBatchResults(poll, {
      signal: input.signal,
    });
    const resultByItem = new Map(results.map((r) => [r.customId, r]));
    const stamp = now();
    for (const row of rows) {
      if (row.runId) affectedRunIds.add(row.runId);
      const key = keyFor(input, row.itemId, row.contentHash, row.dimensions);
      const result = resultByItem.get(row.itemId);
      if (result?.embedding && result.embedding.length === row.dimensions) {
        const stored = await writeReadyEmbedding(
          input.db,
          key,
          result.embedding,
          stamp,
          row.runId,
        );
        if (stored) {
          summary.imported += 1;
        } else {
          summary.stale += 1;
        }
      } else if (result?.embedding) {
        await markEmbeddingState(
          input.db,
          key,
          'blocked_invalid_dimension',
          stamp,
          {
            runId: row.runId,
            error: `provider batch returned ${result.embedding.length} dimensions, expected ${row.dimensions}`,
          },
        );
        summary.blocked += 1;
      } else {
        await markEmbeddingState(input.db, key, 'retryable_error', stamp, {
          runId: row.runId,
          error: result?.error ?? poll.error ?? `provider batch ${poll.state}`,
          resumeAfter: new Date(
            Date.parse(stamp) + IMPORT_RETRY_BACKOFF_MS,
          ).toISOString(),
        });
        summary.retried += 1;
      }
    }
  }

  for (const runId of affectedRunIds) {
    await finalizeRunFromRows(
      input.db,
      runId,
      input.providerName,
      input.model,
      now(),
    );
  }

  return summary;
}

async function finalizeRunFromRows(
  db: Db,
  runId: string,
  providerName: string,
  model: string,
  stamp: string,
): Promise<void> {
  const [run] = await db
    .select({ totalCandidates: Runs.totalCandidates })
    .from(Runs)
    .where(eq(Runs.id, runId))
    .limit(1);
  if (!run) return;
  const rows = await db
    .select({ status: Embeddings.status })
    .from(Embeddings)
    .where(
      and(
        eq(Embeddings.runId, runId),
        eq(Embeddings.provider, providerName),
        eq(Embeddings.model, model),
      ),
    );
  let ready = 0;
  let retryable = 0;
  let blocked = 0;
  let pending = 0;
  let stale = 0;
  for (const row of rows) {
    if (row.status === 'ready') ready += 1;
    else if (row.status === 'retryable_error') retryable += 1;
    else if (row.status === 'blocked_invalid_dimension') blocked += 1;
    else if (row.status === 'stale_content') stale += 1;
    else if (row.status === 'submitted' || row.status === 'processing')
      pending += 1;
  }
  if (pending > 0) return; // batch still in flight; leave run running.
  const status = retryable > 0 ? 'paused' : 'completed';
  await finalizeBackfillRun(db, runId, {
    status,
    counts: {
      totalCandidates: run.totalCandidates,
      processedCount: ready + retryable + blocked + stale,
      readyCount: ready,
      skippedReadyCount: 0,
      retryableCount: retryable,
      blockedCount: blocked,
    },
    pauseReason: retryable > 0 ? 'paused_retryable_provider_error' : null,
    resumeAfter:
      retryable > 0
        ? new Date(Date.parse(stamp) + IMPORT_RETRY_BACKOFF_MS).toISOString()
        : null,
    now: stamp,
  });
}

function keyFor(
  input: { providerName: string; model: string },
  itemId: string,
  contentHash: string,
  dimensions: number,
): EmbeddingRowKey {
  return {
    itemId,
    provider: input.providerName,
    model: input.model,
    dimensions,
    contentHash,
  };
}
