import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import * as pgSchema from '../adapters/storage/postgres/schema/schema.js';
import { nowIso } from './app-memory-service-query-helpers.js';
import type { EmbeddingCacheStore } from './memory-embedding-cache.js';

/**
 * Postgres-backed query-embedding cache over the `embedding_cache` table.
 * Item embeddings live in `memory_item_embeddings`; this cache only memoizes
 * recall *query* embeddings so repeated identical queries skip the provider.
 */
export class PostgresEmbeddingCacheStore implements EmbeddingCacheStore {
  constructor(private readonly db: NodePgDatabase<typeof pgSchema>) {}

  async getCachedEmbedding(
    textHash: string,
    model: string,
    dimensions: number,
  ): Promise<number[] | null> {
    const [row] = await this.db
      .select({
        embeddingJson: pgSchema.embeddingCachePostgres.embeddingJson,
        dimensions: pgSchema.embeddingCachePostgres.dimensions,
      })
      .from(pgSchema.embeddingCachePostgres)
      .where(
        and(
          eq(pgSchema.embeddingCachePostgres.textHash, textHash),
          eq(pgSchema.embeddingCachePostgres.model, model),
        ),
      )
      .limit(1);
    if (!row?.embeddingJson || row.dimensions !== dimensions) return null;
    try {
      const parsed = JSON.parse(row.embeddingJson) as unknown;
      if (Array.isArray(parsed) && parsed.length === dimensions) {
        return parsed as number[];
      }
    } catch {
      return null;
    }
    return null;
  }

  async putCachedEmbedding(
    textHash: string,
    model: string,
    dimensions: number,
    embedding: number[],
  ): Promise<void> {
    const now = nowIso();
    await this.db
      .insert(pgSchema.embeddingCachePostgres)
      .values({
        textHash,
        model,
        dimensions,
        embeddingJson: JSON.stringify(embedding),
        embedding,
        createdAt: now,
      })
      .onConflictDoUpdate({
        target: [
          pgSchema.embeddingCachePostgres.textHash,
          pgSchema.embeddingCachePostgres.model,
        ],
        set: {
          dimensions,
          embeddingJson: JSON.stringify(embedding),
          embedding,
          createdAt: now,
        },
      });
  }
}
