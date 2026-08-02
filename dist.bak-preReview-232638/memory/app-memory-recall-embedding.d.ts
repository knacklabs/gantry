import * as pgSchema from '../adapters/storage/postgres/schema/schema.js';
export interface RecallEmbeddingCapability {
    enabled: boolean;
    provider: string;
    model: string;
    dimensions: number;
    memoryItemEmbeddingsPostgres: typeof pgSchema.memoryItemEmbeddingsPostgres;
    embedQuery: (query: string, signal?: AbortSignal) => Promise<number[] | null>;
}
/**
 * Build the recall query-embedding capability for an app scope. Returns
 * undefined when embeddings are disabled (recall stays lexical-only). The
 * embedder caches query vectors and returns null on budget/quota/rate-limit or
 * provider errors so recall transparently falls back to lexical retrieval.
 */
export declare function buildRecallEmbeddingCapability(db: any, appId: string): RecallEmbeddingCapability | undefined;
