import { and, eq, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import * as pgSchema from '../adapters/storage/postgres/schema/schema.js';
import {
  MEMORY_EMBED_DIMENSIONS,
  MEMORY_EMBED_MODEL,
  MEMORY_EMBED_PROVIDER,
} from '../config/memory.js';
import { getLatestBackfillRun } from './app-memory-backfill-runs.js';

type Db = NodePgDatabase<typeof pgSchema>;
const Items = pgSchema.memoryItemsPostgres;
const Embeddings = pgSchema.memoryItemEmbeddingsPostgres;

export type EmbeddingSearchMode =
  'lexical_keyword' | 'hybrid_semantic_partial' | 'hybrid_semantic_ready';
export type EmbeddingVectorSearch = 'inactive' | 'partial' | 'active';
export type EmbeddingPauseStatus =
  | 'paused_budget'
  | 'paused_provider_quota'
  | 'paused_rate_limit'
  | 'paused_retryable_provider_error';

export interface EmbeddingBackfillStatus {
  enabled: boolean;
  activeItems: number;
  readyItems: number;
  pending: number;
  searchMode: EmbeddingSearchMode;
  vectorSearch: EmbeddingVectorSearch;
  pauseReason?: EmbeddingPauseStatus;
}

function mapPauseReason(
  reason: string | null | undefined,
): EmbeddingPauseStatus | undefined {
  switch (reason) {
    case 'paused_daily_budget':
      return 'paused_budget';
    case 'paused_provider_quota':
      return 'paused_provider_quota';
    case 'paused_rate_limit':
      return 'paused_rate_limit';
    case 'paused_retryable_provider_error':
      return 'paused_retryable_provider_error';
    default:
      return undefined;
  }
}

/**
 * Live semantic-memory status for the scope: how many active items have a ready
 * vector for the current provider/model/dimensions, and whether the latest
 * backfill run is paused. Drives truthful CLI and `/memory-status` surfaces.
 */
export async function getEmbeddingBackfillStatus(
  db: Db,
  scope: { appId: string; agentId?: string | null },
): Promise<EmbeddingBackfillStatus> {
  const enabled = MEMORY_EMBED_PROVIDER !== 'disabled';
  const activeWhere = and(
    eq(Items.appId, scope.appId),
    eq(Items.status, 'active'),
    scope.agentId ? eq(Items.agentId, scope.agentId) : undefined,
  );
  const [activeRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(Items)
    .where(activeWhere);
  const activeItems = Number(activeRow?.count ?? 0);

  let readyItems = 0;
  if (enabled) {
    const [readyRow] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(Items)
      .where(
        and(
          activeWhere,
          sql`exists (select 1 from ${Embeddings} e where e.item_id = ${Items.id} and e.provider = ${MEMORY_EMBED_PROVIDER} and e.model = ${MEMORY_EMBED_MODEL} and e.dimensions = ${MEMORY_EMBED_DIMENSIONS} and e.status = 'ready' and e.embedding is not null)`,
        ),
      );
    readyItems = Number(readyRow?.count ?? 0);
  }
  const pending = Math.max(0, activeItems - readyItems);

  const latestRun = await getLatestBackfillRun(db, scope.appId, scope.agentId);
  const pauseReason =
    latestRun?.status === 'paused'
      ? mapPauseReason(latestRun.pauseReason)
      : undefined;

  let searchMode: EmbeddingSearchMode = 'lexical_keyword';
  let vectorSearch: EmbeddingVectorSearch = 'inactive';
  if (enabled && readyItems > 0) {
    if (pending > 0) {
      searchMode = 'hybrid_semantic_partial';
      vectorSearch = 'partial';
    } else {
      searchMode = 'hybrid_semantic_ready';
      vectorSearch = 'active';
    }
  }

  return {
    enabled,
    activeItems,
    readyItems,
    pending,
    searchMode,
    vectorSearch,
    ...(pauseReason ? { pauseReason } : {}),
  };
}
