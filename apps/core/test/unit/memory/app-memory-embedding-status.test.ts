import { afterEach, describe, expect, it, vi } from 'vitest';

let provider: string;
let counts: number[];
let callIndex: number;
let latestRun: unknown;

async function loadStatus() {
  vi.resetModules();
  vi.doMock('@core/config/memory.js', () => ({
    MEMORY_EMBED_PROVIDER: provider,
    MEMORY_EMBED_MODEL: 'text-embedding-3-small',
    MEMORY_EMBED_DIMENSIONS: 1536,
  }));
  vi.doMock('@core/memory/app-memory-backfill-runs.js', () => ({
    getLatestBackfillRun: vi.fn(async () => latestRun),
  }));
  const mod = await import('@core/memory/app-memory-embedding-status.js');
  return mod.getEmbeddingBackfillStatus;
}

function fakeDb() {
  return {
    select: () => ({
      from: () => ({
        where: async () => [{ count: counts[callIndex++] ?? 0 }],
      }),
    }),
  };
}

afterEach(() => {
  vi.doUnmock('@core/config/memory.js');
  vi.doUnmock('@core/memory/app-memory-backfill-runs.js');
});

describe('getEmbeddingBackfillStatus', () => {
  it('reports lexical_keyword when embeddings are disabled', async () => {
    provider = 'disabled';
    counts = [5];
    callIndex = 0;
    latestRun = null;
    const fn = await loadStatus();
    const status = await fn(fakeDb() as never, { appId: 'default' });
    expect(status.enabled).toBe(false);
    expect(status.readyItems).toBe(0);
    expect(status.searchMode).toBe('lexical_keyword');
    expect(status.vectorSearch).toBe('inactive');
  });

  it('reports hybrid_semantic_partial when some items are indexed and some pending', async () => {
    provider = 'openai';
    counts = [5, 2];
    callIndex = 0;
    latestRun = null;
    const fn = await loadStatus();
    const status = await fn(fakeDb() as never, { appId: 'default' });
    expect(status.searchMode).toBe('hybrid_semantic_partial');
    expect(status.vectorSearch).toBe('partial');
    expect(status.pending).toBe(3);
  });

  it('reports hybrid_semantic_ready when nothing is pending', async () => {
    provider = 'openai';
    counts = [3, 3];
    callIndex = 0;
    latestRun = null;
    const fn = await loadStatus();
    const status = await fn(fakeDb() as never, { appId: 'default' });
    expect(status.searchMode).toBe('hybrid_semantic_ready');
    expect(status.vectorSearch).toBe('active');
    expect(status.pending).toBe(0);
  });

  it('maps a paused daily-budget run to paused_budget', async () => {
    provider = 'openai';
    counts = [5, 2];
    callIndex = 0;
    latestRun = { status: 'paused', pauseReason: 'paused_daily_budget' };
    const fn = await loadStatus();
    const status = await fn(fakeDb() as never, { appId: 'default' });
    expect(status.pauseReason).toBe('paused_budget');
  });
});
