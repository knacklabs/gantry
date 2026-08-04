import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as pgSchema from '../adapters/storage/postgres/schema/schema.js';
import type { EmbeddingCacheStore } from './memory-embedding-cache.js';
/**
 * Postgres-backed query-embedding cache over the `embedding_cache` table.
 * Item embeddings live in `memory_item_embeddings`; this cache only memoizes
 * recall *query* embeddings so repeated identical queries skip the provider.
 */
export declare class PostgresEmbeddingCacheStore implements EmbeddingCacheStore {
    private readonly db;
    constructor(db: NodePgDatabase<typeof pgSchema>);
    getCachedEmbedding(textHash: string, model: string, dimensions: number): Promise<number[] | null>;
    putCachedEmbedding(textHash: string, model: string, dimensions: number, embedding: number[]): Promise<void>;
}
