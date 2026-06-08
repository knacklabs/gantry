import { and, asc, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import * as pgSchema from '../adapters/storage/postgres/schema/schema.js';
import { embeddingTextForMemory } from './app-memory-service-helpers.js';

type Db = NodePgDatabase<typeof pgSchema>;

const Items = pgSchema.memoryItemsPostgres;
const Embeddings = pgSchema.memoryItemEmbeddingsPostgres;

/** Default window after which a `processing` row is treated as stuck/abandoned. */
export const PROCESSING_LEASE_MS = 15 * 60 * 1000;

export interface BackfillCandidate {
  itemId: string;
  key: string;
  value: string;
  why: string | null;
  contentHash: string;
  text: string;
}

export interface CandidateScanResult {
  candidates: BackfillCandidate[];
  skippedReady: number;
  scanned: number;
}

function itemValueExpr(): ReturnType<typeof sql> {
  return sql`COALESCE(${Items.valueJson}->>'value', '')`;
}

function itemWhyExpr(): ReturnType<typeof sql> {
  return sql`COALESCE(${Items.valueJson}->>'why', '')`;
}

function itemEmbeddingContentHashExpr(): ReturnType<typeof sql> {
  return sql`encode(digest(${Items.key} || E'\n' || ${itemValueExpr()} || E'\n' || ${itemWhyExpr()}, 'sha256'), 'hex')`;
}

function activeItemWhere(scope: {
  appId: string;
  agentId?: string | null;
}): ReturnType<typeof and> {
  return and(
    eq(Items.appId, scope.appId),
    eq(Items.status, 'active'),
    scope.agentId ? eq(Items.agentId, scope.agentId) : undefined,
  );
}

function hasCurrentNonEligibleEmbedding(scope: {
  provider: string;
  model: string;
  dimensions: number;
  now: string;
  leaseMs: number;
}): ReturnType<typeof sql> {
  const currentHash = itemEmbeddingContentHashExpr();
  return sql`exists (
    select 1
    from ${Embeddings}
    where ${Embeddings.itemId} = ${Items.id}
      and ${Embeddings.provider} = ${scope.provider}
      and ${Embeddings.model} = ${scope.model}
      and ${Embeddings.dimensions} = ${scope.dimensions}
      and ${Embeddings.contentHash} = ${currentHash}
      and (
        ${Embeddings.status} = 'ready'
        or ${Embeddings.status} = 'submitted'
        or ${Embeddings.status} = 'blocked_invalid_dimension'
        or (
          ${Embeddings.status} = 'processing'
          and COALESCE(${Embeddings.lastAttemptAt}, ${Embeddings.updatedAt}) + (${scope.leaseMs}::text || ' milliseconds')::interval > ${scope.now}::timestamptz
        )
        or (
          ${Embeddings.status} = 'retryable_error'
          and ${Embeddings.resumeAfter} is not null
          and ${Embeddings.resumeAfter} > ${scope.now}::timestamptz
        )
      )
  )`;
}

function hasCurrentReadyEmbedding(scope: {
  provider: string;
  model: string;
  dimensions: number;
}): ReturnType<typeof sql> {
  const currentHash = itemEmbeddingContentHashExpr();
  return sql`exists (
    select 1
    from ${Embeddings}
    where ${Embeddings.itemId} = ${Items.id}
      and ${Embeddings.provider} = ${scope.provider}
      and ${Embeddings.model} = ${scope.model}
      and ${Embeddings.dimensions} = ${scope.dimensions}
      and ${Embeddings.contentHash} = ${currentHash}
      and ${Embeddings.status} = 'ready'
  )`;
}

/**
 * Find active memory items in scope that still need an embedding for the given
 * (provider, model, dimensions): missing, stale content hash, retryable rows
 * past `resume_after`, queued rows, and `processing` rows whose lease expired.
 * Rows already `ready` for the current content hash (and `submitted`/blocked
 * rows for the current hash) are skipped. Oldest items are returned first.
 */
export async function selectBackfillCandidates(
  db: Db,
  scope: {
    appId: string;
    agentId?: string | null;
    provider: string;
    model: string;
    dimensions: number;
    scanLimit: number;
    now: string;
    processingLeaseMs?: number;
  },
): Promise<CandidateScanResult> {
  const leaseMs = scope.processingLeaseMs ?? PROCESSING_LEASE_MS;
  const baseWhere = activeItemWhere(scope);
  const currentHash = itemEmbeddingContentHashExpr();
  const nonEligible = hasCurrentNonEligibleEmbedding({
    provider: scope.provider,
    model: scope.model,
    dimensions: scope.dimensions,
    now: scope.now,
    leaseMs,
  });
  const itemRows = await db
    .select({
      id: Items.id,
      key: Items.key,
      valueJson: Items.valueJson,
      updatedAt: Items.updatedAt,
      contentHash: currentHash,
    })
    .from(Items)
    .where(and(baseWhere, sql`not (${nonEligible})`))
    .orderBy(asc(Items.updatedAt), asc(Items.id))
    .limit(Math.max(1, scope.scanLimit));

  if (itemRows.length === 0) {
    const [readyRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(Items)
      .where(
        and(
          baseWhere,
          hasCurrentReadyEmbedding({
            provider: scope.provider,
            model: scope.model,
            dimensions: scope.dimensions,
          }),
        ),
      );
    return {
      candidates: [],
      skippedReady: Number(readyRow?.count ?? 0),
      scanned: 0,
    };
  }

  const candidates: BackfillCandidate[] = [];
  for (const item of itemRows) {
    const valueJson = (item.valueJson ?? {}) as {
      value?: string;
      why?: string | null;
    };
    const value = typeof valueJson.value === 'string' ? valueJson.value : '';
    const why = typeof valueJson.why === 'string' ? valueJson.why : null;
    candidates.push({
      itemId: item.id,
      key: item.key,
      value,
      why,
      contentHash: String(item.contentHash),
      text: embeddingTextForMemory({ key: item.key, value, why }),
    });
  }

  const [readyRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(Items)
    .where(
      and(
        baseWhere,
        hasCurrentReadyEmbedding({
          provider: scope.provider,
          model: scope.model,
          dimensions: scope.dimensions,
        }),
      ),
    );

  return {
    candidates,
    skippedReady: Number(readyRow?.count ?? 0),
    scanned: itemRows.length,
  };
}
