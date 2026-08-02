import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as pgSchema from '../adapters/storage/postgres/schema/schema.js';
type Db = NodePgDatabase<typeof pgSchema>;
export type EmbeddingSearchMode = 'lexical_keyword' | 'hybrid_semantic_partial' | 'hybrid_semantic_ready';
export type EmbeddingVectorSearch = 'inactive' | 'partial' | 'active';
export type EmbeddingPauseStatus = 'paused_budget' | 'paused_provider_quota' | 'paused_rate_limit' | 'paused_retryable_provider_error';
export interface EmbeddingBackfillStatus {
    enabled: boolean;
    activeItems: number;
    readyItems: number;
    pending: number;
    searchMode: EmbeddingSearchMode;
    vectorSearch: EmbeddingVectorSearch;
    pauseReason?: EmbeddingPauseStatus;
}
/**
 * Live semantic-memory status for the scope: how many active items have a ready
 * vector for the current provider/model/dimensions, and whether the latest
 * backfill run is paused. Drives truthful CLI and `/memory-status` surfaces.
 */
export declare function getEmbeddingBackfillStatus(db: Db, scope: {
    appId: string;
    agentId?: string | null;
}): Promise<EmbeddingBackfillStatus>;
export {};
