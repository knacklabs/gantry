import crypto from 'crypto';

import {
  MEMORY_EMBED_DIMENSIONS,
  MEMORY_EMBED_MODEL,
  OPENAI_DAILY_EMBED_LIMIT,
} from '../config/index.js';
import { logger } from '../infrastructure/logging/logger.js';
import { EmbeddingProviderError } from './memory-embedding-errors.js';
import type { EmbeddingProvider } from './memory-embeddings.js';
import { nowDate } from '../shared/time/datetime.js';

export interface EmbeddingCacheStore {
  getCachedEmbedding(
    textHash: string,
    model: string,
    dimensions: number,
  ): Promise<number[] | null>;
  putCachedEmbedding(
    textHash: string,
    model: string,
    dimensions: number,
    embedding: number[],
  ): Promise<void>;
}

let dailyApiCalls = 0;
let dailyResetDate = nowDate().toDateString();

function trackAndCheckBudget(callCount: number): boolean {
  const today = nowDate().toDateString();
  if (today !== dailyResetDate) {
    dailyApiCalls = 0;
    dailyResetDate = today;
  }

  if (
    OPENAI_DAILY_EMBED_LIMIT > 0 &&
    dailyApiCalls + callCount > OPENAI_DAILY_EMBED_LIMIT
  ) {
    logger.warn(
      {
        dailyApiCalls,
        dailyLimit: OPENAI_DAILY_EMBED_LIMIT,
        requestedCalls: callCount,
      },
      'Daily embed limit reached. Skipping API call',
    );
    return false;
  }

  dailyApiCalls += callCount;
  return true;
}

function dailyBudgetError(): EmbeddingProviderError {
  return new EmbeddingProviderError(
    'daily_budget',
    'daily embedding budget reached',
  );
}

export class CachedEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly inner: EmbeddingProvider,
    private readonly store: EmbeddingCacheStore,
    private readonly model: string = MEMORY_EMBED_MODEL,
    private readonly dimensions: number = MEMORY_EMBED_DIMENSIONS,
  ) {}

  isEnabled(): boolean {
    return this.inner.isEnabled();
  }

  validateConfiguration(): void {
    this.inner.validateConfiguration();
  }

  async embedOne(
    text: string,
    options?: { signal?: AbortSignal },
  ): Promise<number[]> {
    const hash = hashText(text);
    const cached = await this.store.getCachedEmbedding(
      hash,
      this.model,
      this.dimensions,
    );
    if (cached) return cached;

    if (!trackAndCheckBudget(1)) {
      throw dailyBudgetError();
    }

    const embedding = await this.inner.embedOne(text, options);
    await this.store.putCachedEmbedding(
      hash,
      this.model,
      this.dimensions,
      embedding,
    );
    return embedding;
  }

  async embedMany(
    texts: string[],
    options?: { signal?: AbortSignal },
  ): Promise<number[][]> {
    if (texts.length === 0) return [];

    const results: Array<number[] | null> = new Array(texts.length).fill(null);
    const misses = new Map<string, { text: string; indexes: number[] }>();

    await Promise.all(
      texts.map(async (text, index) => {
        const hash = hashText(text);
        const cached = await this.store.getCachedEmbedding(
          hash,
          this.model,
          this.dimensions,
        );
        if (cached) {
          results[index] = cached;
          return;
        }

        const existing = misses.get(hash);
        if (existing) {
          existing.indexes.push(index);
          return;
        }

        misses.set(hash, { text, indexes: [index] });
      }),
    );

    if (misses.size > 0) {
      const missEntries = [...misses.entries()];
      const missingTexts = missEntries.map(([, value]) => value.text);
      if (!trackAndCheckBudget(missingTexts.length)) {
        throw dailyBudgetError();
      }
      const embeddings = await this.inner.embedMany(missingTexts, options);

      if (embeddings.length !== missEntries.length) {
        throw new Error(
          `embedding provider returned ${embeddings.length} vectors for ${missEntries.length} uncached texts`,
        );
      }

      await Promise.all(
        missEntries.map(async ([hash, value], index) => {
          const embedding = embeddings[index];
          if (!embedding) return;
          await this.store.putCachedEmbedding(
            hash,
            this.model,
            this.dimensions,
            embedding,
          );
          for (const resultIndex of value.indexes) {
            results[resultIndex] = embedding;
          }
        }),
      );
    }

    return results.map((embedding, index) => {
      if (!embedding) {
        throw new Error(`missing embedding at index ${index}`);
      }
      return embedding;
    });
  }
}

function hashText(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}
