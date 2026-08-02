import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as pgSchema from '../adapters/storage/postgres/schema/schema.js';
type Db = NodePgDatabase<typeof pgSchema>;
export interface EmbeddingRowKey {
    itemId: string;
    provider: string;
    model: string;
    dimensions: number;
    contentHash: string;
}
export type PendingEmbeddingStatus = 'queued' | 'processing' | 'submitted' | 'retryable_error' | 'stale_content' | 'blocked_invalid_dimension';
/**
 * Persist a ready vector for an item and prune any sibling rows for the same
 * (item, provider, model) carrying a different content hash. Pruning keeps at
 * most one ready embedding per item so vector recall always reflects the item's
 * current text without recomputing the hash in SQL.
 */
export declare function writeReadyEmbedding(db: Db, key: EmbeddingRowKey, embedding: number[], now: string, runId?: string | null): Promise<boolean>;
/**
 * Upsert a non-ready embedding row (queued/processing/submitted/error). Never
 * overwrites an existing ready row for the same content hash.
 */
export declare function markEmbeddingState(db: Db, key: EmbeddingRowKey, status: PendingEmbeddingStatus, now: string, options?: {
    error?: string | null;
    resumeAfter?: string | null;
    runId?: string | null;
    providerBatchId?: string | null;
    incrementAttempt?: boolean;
    touchAttempt?: boolean;
}): Promise<void>;
export {};
