import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as pgSchema from '../adapters/storage/postgres/schema/schema.js';
import type { BackfillCandidate } from './app-memory-backfill-candidates.js';
import type { EmbeddingProvider } from './memory-embeddings.js';
type Db = NodePgDatabase<typeof pgSchema>;
/** True when a provider can submit async embedding batches (backfill only). */
export declare function supportsProviderBatch(provider: EmbeddingProvider): boolean;
/**
 * Submit candidates as one async provider batch and mark their rows `submitted`
 * with the returned provider batch id. Returns the number of items submitted.
 * Live recall never calls this; batches are backfill-only.
 */
export declare function submitProviderEmbeddingBatch(input: {
    db: Db;
    provider: EmbeddingProvider;
    providerName: string;
    model: string;
    dimensions: number;
    runId: string;
    candidates: BackfillCandidate[];
    now: () => string;
    signal?: AbortSignal;
}): Promise<number>;
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
export declare function pollAndImportProviderBatches(input: {
    db: Db;
    provider: EmbeddingProvider;
    providerName: string;
    model: string;
    now?: () => string;
    signal?: AbortSignal;
    maxBatches?: number;
    maxRows?: number;
}): Promise<ProviderBatchPollSummary>;
export {};
