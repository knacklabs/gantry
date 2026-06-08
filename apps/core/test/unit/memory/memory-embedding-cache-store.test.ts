import { describe, expect, it } from 'vitest';

import { PostgresEmbeddingCacheStore } from '@core/memory/memory-embedding-cache-store.js';

function fakeDb(row: unknown) {
  const insertCalls: any[] = [];
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (row ? [row] : []) }),
      }),
    }),
    insert: () => ({
      values: (value: any) => {
        insertCalls.push(value);
        return { onConflictDoUpdate: async () => undefined };
      },
    }),
  };
  return { db, insertCalls };
}

describe('PostgresEmbeddingCacheStore', () => {
  it('returns the cached vector on a dimension + length match', async () => {
    const { db } = fakeDb({
      embeddingJson: JSON.stringify([0.1, 0.2]),
      dimensions: 2,
    });
    const store = new PostgresEmbeddingCacheStore(db as never);
    expect(await store.getCachedEmbedding('h', 'm', 2)).toEqual([0.1, 0.2]);
  });

  it('misses when the stored dimensions differ from requested', async () => {
    const { db } = fakeDb({
      embeddingJson: JSON.stringify([0.1, 0.2]),
      dimensions: 3,
    });
    const store = new PostgresEmbeddingCacheStore(db as never);
    expect(await store.getCachedEmbedding('h', 'm', 2)).toBeNull();
  });

  it('misses when the parsed vector length differs from requested dimensions', async () => {
    const { db } = fakeDb({
      embeddingJson: JSON.stringify([0.1]),
      dimensions: 2,
    });
    const store = new PostgresEmbeddingCacheStore(db as never);
    expect(await store.getCachedEmbedding('h', 'm', 2)).toBeNull();
  });

  it('misses when no row exists', async () => {
    const { db } = fakeDb(null);
    const store = new PostgresEmbeddingCacheStore(db as never);
    expect(await store.getCachedEmbedding('h', 'm', 2)).toBeNull();
  });

  it('upserts with the dimensions recorded on put', async () => {
    const { db, insertCalls } = fakeDb(null);
    const store = new PostgresEmbeddingCacheStore(db as never);
    await store.putCachedEmbedding('h', 'm', 2, [0.1, 0.2]);
    expect(insertCalls[0]).toMatchObject({
      textHash: 'h',
      model: 'm',
      dimensions: 2,
    });
  });
});
