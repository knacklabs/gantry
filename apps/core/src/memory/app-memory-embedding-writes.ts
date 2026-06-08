import { and, eq, ne, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import * as pgSchema from '../adapters/storage/postgres/schema/schema.js';
import { embeddingContentHash } from './app-memory-service-helpers.js';

const T = pgSchema.memoryItemEmbeddingsPostgres;
const Items = pgSchema.memoryItemsPostgres;

type Db = NodePgDatabase<typeof pgSchema>;

export interface EmbeddingRowKey {
  itemId: string;
  provider: string;
  model: string;
  dimensions: number;
  contentHash: string;
}

export type PendingEmbeddingStatus =
  | 'queued'
  | 'processing'
  | 'submitted'
  | 'retryable_error'
  | 'stale_content'
  | 'blocked_invalid_dimension';

async function currentContentHashForItem(
  db: Db,
  itemId: string,
): Promise<string | null> {
  const [item] = await db
    .select({
      key: Items.key,
      valueJson: Items.valueJson,
      status: Items.status,
    })
    .from(Items)
    .where(eq(Items.id, itemId))
    .limit(1);
  if (!item || item.status !== 'active') return null;
  const valueJson = (item.valueJson ?? {}) as {
    value?: string;
    why?: string | null;
  };
  const value = typeof valueJson.value === 'string' ? valueJson.value : '';
  const why = typeof valueJson.why === 'string' ? valueJson.why : null;
  return embeddingContentHash({ key: item.key, value, why });
}

/**
 * Persist a ready vector for an item and prune any sibling rows for the same
 * (item, provider, model) carrying a different content hash. Pruning keeps at
 * most one ready embedding per item so vector recall always reflects the item's
 * current text without recomputing the hash in SQL.
 */
export async function writeReadyEmbedding(
  db: Db,
  key: EmbeddingRowKey,
  embedding: number[],
  now: string,
  runId: string | null = null,
): Promise<boolean> {
  const currentHash = await currentContentHashForItem(db, key.itemId);
  if (currentHash !== key.contentHash) {
    await markEmbeddingState(db, key, 'stale_content', now, {
      runId,
      error: 'embedding result ignored because memory item content changed',
    });
    return false;
  }
  await db
    .insert(T)
    .values({
      itemId: key.itemId,
      provider: key.provider,
      model: key.model,
      contentHash: key.contentHash,
      dimensions: key.dimensions,
      embeddingJson: JSON.stringify(embedding),
      embedding,
      status: 'ready',
      error: null,
      runId,
      resumeAfter: null,
      lastAttemptAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [T.itemId, T.provider, T.model, T.contentHash],
      set: {
        dimensions: key.dimensions,
        embeddingJson: JSON.stringify(embedding),
        embedding,
        status: 'ready',
        error: null,
        runId,
        resumeAfter: null,
        lastAttemptAt: now,
        updatedAt: now,
      },
    });
  await db
    .delete(T)
    .where(
      and(
        eq(T.itemId, key.itemId),
        eq(T.provider, key.provider),
        eq(T.model, key.model),
        ne(T.contentHash, key.contentHash),
      ),
    );
  return true;
}

/**
 * Upsert a non-ready embedding row (queued/processing/submitted/error). Never
 * overwrites an existing ready row for the same content hash.
 */
export async function markEmbeddingState(
  db: Db,
  key: EmbeddingRowKey,
  status: PendingEmbeddingStatus,
  now: string,
  options: {
    error?: string | null;
    resumeAfter?: string | null;
    runId?: string | null;
    providerBatchId?: string | null;
    incrementAttempt?: boolean;
    touchAttempt?: boolean;
  } = {},
): Promise<void> {
  await db
    .insert(T)
    .values({
      itemId: key.itemId,
      provider: key.provider,
      model: key.model,
      contentHash: key.contentHash,
      dimensions: key.dimensions,
      embeddingJson: null,
      embedding: null,
      status,
      error: options.error ?? null,
      attemptCount: options.incrementAttempt ? 1 : 0,
      lastAttemptAt: options.touchAttempt ? now : null,
      resumeAfter: options.resumeAfter ?? null,
      runId: options.runId ?? null,
      providerBatchId: options.providerBatchId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [T.itemId, T.provider, T.model, T.contentHash],
      set: {
        dimensions: key.dimensions,
        status,
        error: options.error ?? null,
        ...(options.incrementAttempt
          ? { attemptCount: sql`${T.attemptCount} + 1` }
          : {}),
        ...(options.touchAttempt ? { lastAttemptAt: now } : {}),
        resumeAfter: options.resumeAfter ?? null,
        runId: options.runId ?? null,
        providerBatchId: options.providerBatchId ?? null,
        updatedAt: now,
      },
      where: ne(T.status, 'ready'),
    });
}
