import * as pgSchema from '../adapters/storage/postgres/schema/schema.js';
import {
  MEMORY_EMBED_DIMENSIONS,
  MEMORY_EMBED_MODEL,
  MEMORY_EMBED_PROVIDER,
} from '../config/memory.js';
import type { AppId } from '../domain/app/app.js';
import { logger } from '../infrastructure/logging/logger.js';
import { isLexicalFallbackError } from './memory-embedding-errors.js';
import { CachedEmbeddingProvider } from './memory-embedding-cache.js';
import { PostgresEmbeddingCacheStore } from './memory-embedding-cache-store.js';
import { createEmbeddingProvider } from './memory-embeddings.js';

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
export function buildRecallEmbeddingCapability(
  db: any,
  appId: string,
): RecallEmbeddingCapability | undefined {
  if (MEMORY_EMBED_PROVIDER === 'disabled') return undefined;
  return {
    enabled: true,
    provider: MEMORY_EMBED_PROVIDER,
    model: MEMORY_EMBED_MODEL,
    dimensions: MEMORY_EMBED_DIMENSIONS,
    memoryItemEmbeddingsPostgres: pgSchema.memoryItemEmbeddingsPostgres,
    embedQuery: async (query, signal) => {
      try {
        const inner = createEmbeddingProvider(MEMORY_EMBED_PROVIDER, {
          model: MEMORY_EMBED_MODEL,
          dimensions: MEMORY_EMBED_DIMENSIONS,
          appId: appId as AppId,
        });
        const cached = new CachedEmbeddingProvider(
          inner,
          new PostgresEmbeddingCacheStore(db),
          MEMORY_EMBED_MODEL,
          MEMORY_EMBED_DIMENSIONS,
        );
        return await cached.embedOne(query, { signal });
      } catch (error) {
        if (signal?.aborted) throw error;
        // Budget/quota/rate-limit/transient errors are expected pauses; config or
        // dimension errors are not, so log those louder. Either way recall falls
        // back to lexical so a misconfigured embedder never breaks search.
        const expected = isLexicalFallbackError(error);
        logger[expected ? 'debug' : 'warn'](
          { err: error },
          'memory recall query embedding unavailable; falling back to lexical recall',
        );
        return null;
      }
    },
  };
}
