import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const VECTOR = Array.from({ length: 1536 }, () => 0.01);

function makeCandidate(index: number) {
  return {
    itemId: `item-${index}`,
    key: `key-${index}`,
    value: `value-${index}`,
    why: null,
    contentHash: `hash-${index}`,
    text: `key-${index}\nvalue-${index}\n`,
  };
}

let writeReadyEmbedding: ReturnType<typeof vi.fn>;
let markEmbeddingState: ReturnType<typeof vi.fn>;
let finalizeArgs: any;
let candidates: ReturnType<typeof makeCandidate>[];
let createBackfillRunError: unknown;
let activePause: any;
let supportsBatch: boolean;
let submitBatchImpl: (input: any) => Promise<number>;

// Resets the module registry so the doMocks apply, then returns the engine and
// the *same* EmbeddingProviderError class the engine imports (so instanceof
// checks line up across the reset boundary).
async function loadEngine() {
  vi.resetModules();
  writeReadyEmbedding = vi.fn(async () => true);
  markEmbeddingState = vi.fn(async () => undefined);
  finalizeArgs = undefined;
  createBackfillRunError = undefined;
  activePause = null;
  supportsBatch = false;
  submitBatchImpl = async () => 0;
  vi.doMock('@core/memory/app-memory-backfill-candidates.js', () => ({
    PROCESSING_LEASE_MS: 900_000,
    selectBackfillCandidates: vi.fn(async () => ({
      candidates,
      skippedReady: 0,
      scanned: candidates.length,
    })),
  }));
  vi.doMock('@core/memory/app-memory-backfill-runs.js', () => ({
    createBackfillRun: vi.fn(async () => {
      if (createBackfillRunError) throw createBackfillRunError;
    }),
    getActiveBackfillPause: vi.fn(async () => activePause),
    finalizeBackfillRun: vi.fn(async (_db: unknown, _id: string, args: any) => {
      finalizeArgs = args;
    }),
  }));
  vi.doMock('@core/memory/app-memory-embedding-writes.js', () => ({
    writeReadyEmbedding,
    markEmbeddingState,
  }));
  vi.doMock('@core/memory/app-memory-backfill-provider-batch.js', () => ({
    supportsProviderBatch: () => supportsBatch,
    submitProviderEmbeddingBatch: vi.fn(async (input: any) =>
      submitBatchImpl(input),
    ),
  }));
  const engine = await import('@core/memory/app-memory-backfill.js');
  const errors = await import('@core/memory/memory-embedding-errors.js');
  return {
    runEmbeddingBackfill: engine.runEmbeddingBackfill,
    EmbeddingProviderError: errors.EmbeddingProviderError,
  };
}

function baseInput(embedMany: ReturnType<typeof vi.fn>) {
  return {
    db: {},
    appId: 'default',
    trigger: 'cli' as const,
    provider: 'openai',
    model: 'text-embedding-3-small',
    dimensions: 1536,
    batchSize: 2,
    dailyLimit: 500,
    maxItemsPerRun: 500,
    providerBatchMinItems: 100,
    mode: 'inline' as const,
    embeddingProvider: {
      isEnabled: () => true,
      validateConfiguration: vi.fn(),
      embedMany,
      embedOne: vi.fn(),
    } as never,
    now: () => '2026-05-30T00:00:00.000Z',
  };
}

afterEach(() => {
  vi.doUnmock('@core/memory/app-memory-backfill-candidates.js');
  vi.doUnmock('@core/memory/app-memory-backfill-runs.js');
  vi.doUnmock('@core/memory/app-memory-embedding-writes.js');
  vi.doUnmock('@core/memory/app-memory-backfill-provider-batch.js');
});

describe('runEmbeddingBackfill (inline)', () => {
  beforeEach(() => {
    candidates = [makeCandidate(0), makeCandidate(1), makeCandidate(2)];
  });

  it('completes when every candidate embeds', async () => {
    const { runEmbeddingBackfill } = await loadEngine();
    const embedMany = vi.fn(async (texts: string[]) => texts.map(() => VECTOR));
    const result = await runEmbeddingBackfill(baseInput(embedMany));
    expect(result.status).toBe('completed');
    expect(result.indexed).toBe(3);
    expect(result.pending).toBe(0);
    expect(writeReadyEmbedding).toHaveBeenCalledTimes(3);
    expect(finalizeArgs.status).toBe('completed');
  });

  it('stores completed rows before pausing on a provider quota error', async () => {
    const { runEmbeddingBackfill, EmbeddingProviderError } = await loadEngine();
    const embedMany = vi
      .fn()
      .mockResolvedValueOnce([VECTOR, VECTOR])
      .mockRejectedValueOnce(
        new EmbeddingProviderError('provider_quota', 'insufficient funds'),
      );
    const result = await runEmbeddingBackfill(baseInput(embedMany));
    expect(result.status).toBe('paused');
    expect(result.pauseReason).toBe('paused_provider_quota');
    expect(result.indexed).toBe(2);
    expect(result.pending).toBe(1);
    expect(writeReadyEmbedding).toHaveBeenCalledTimes(2);
    const retryableCalls = markEmbeddingState.mock.calls.filter(
      (call) => call[2] === 'retryable_error',
    );
    expect(retryableCalls).toHaveLength(1);
    expect(finalizeArgs.status).toBe('paused');
    expect(finalizeArgs.pauseReason).toBe('paused_provider_quota');
  });

  it('does not call the provider while a prior quota pause is still active', async () => {
    const { runEmbeddingBackfill } = await loadEngine();
    activePause = {
      id: 'paused-run',
      mode: 'inline',
      totalCandidates: 25,
      readyCount: 10,
      skippedReadyCount: 3,
      blockedCount: 0,
      pauseReason: 'paused_provider_quota',
      lastErrorCode: 'provider_quota',
      lastErrorMessage: 'no funds',
    };
    const embedMany = vi.fn(async (texts: string[]) => texts.map(() => VECTOR));
    const result = await runEmbeddingBackfill(baseInput(embedMany));
    expect(result).toMatchObject({
      runId: 'paused-run',
      status: 'paused',
      pauseReason: 'paused_provider_quota',
      pausedByPriorRun: true,
    });
    expect(embedMany).not.toHaveBeenCalled();
    expect(writeReadyEmbedding).not.toHaveBeenCalled();
  });

  it('no-ops when another inline run already holds the lock', async () => {
    const { runEmbeddingBackfill } = await loadEngine();
    createBackfillRunError = { code: '23505' }; // unique violation
    const embedMany = vi.fn(async (texts: string[]) => texts.map(() => VECTOR));
    const result = await runEmbeddingBackfill(baseInput(embedMany));
    expect(result.alreadyRunning).toBe(true);
    expect(embedMany).not.toHaveBeenCalled();
    expect(writeReadyEmbedding).not.toHaveBeenCalled();
  });

  it('fails and blocks the chunk on a dimension mismatch', async () => {
    const { runEmbeddingBackfill, EmbeddingProviderError } = await loadEngine();
    const embedMany = vi
      .fn()
      .mockRejectedValue(
        new EmbeddingProviderError(
          'invalid_dimension',
          'model returned 3072 dimensions, but Gantry semantic memory is configured for 1536',
        ),
      );
    const result = await runEmbeddingBackfill(baseInput(embedMany));
    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('invalid_dimension');
    expect(writeReadyEmbedding).not.toHaveBeenCalled();
    const blockedCalls = markEmbeddingState.mock.calls.filter(
      (call) => call[2] === 'blocked_invalid_dimension',
    );
    expect(blockedCalls.length).toBeGreaterThanOrEqual(1);
    expect(finalizeArgs.status).toBe('failed');
  });

  it('pauses on the daily budget with remaining items', async () => {
    const { runEmbeddingBackfill } = await loadEngine();
    const embedMany = vi.fn(async (texts: string[]) => texts.map(() => VECTOR));
    const result = await runEmbeddingBackfill({
      ...baseInput(embedMany),
      dailyLimit: 2,
      batchSize: 1,
    });
    expect(result.status).toBe('paused');
    expect(result.pauseReason).toBe('paused_daily_budget');
    expect(result.indexed).toBe(2);
    expect(result.pending).toBeGreaterThan(0);
  });

  it('marks an item retryable when the provider returns no vector', async () => {
    candidates = [makeCandidate(0), makeCandidate(1)];
    const { runEmbeddingBackfill } = await loadEngine();
    const embedMany = vi.fn(async () => [VECTOR, undefined]);
    const result = await runEmbeddingBackfill(baseInput(embedMany));
    expect(result.status).toBe('completed');
    expect(result.indexed).toBe(1);
    expect(writeReadyEmbedding).toHaveBeenCalledTimes(1);
    expect(
      markEmbeddingState.mock.calls.some(
        (call) => call[2] === 'retryable_error',
      ),
    ).toBe(true);
  });

  it('does not count stale writes as indexed', async () => {
    candidates = [makeCandidate(0), makeCandidate(1)];
    const { runEmbeddingBackfill } = await loadEngine();
    writeReadyEmbedding
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const embedMany = vi.fn(async () => [VECTOR, VECTOR]);
    const result = await runEmbeddingBackfill(baseInput(embedMany));
    expect(result.indexed).toBe(1);
    expect(result.pending).toBe(0);
    expect(finalizeArgs.counts.processedCount).toBe(2);
  });

  it('submits a provider batch in auto mode when supported and pending >= min', async () => {
    const { runEmbeddingBackfill } = await loadEngine();
    supportsBatch = true;
    submitBatchImpl = async (input) => input.candidates.length;
    const embedMany = vi.fn();
    const result = await runEmbeddingBackfill({
      ...baseInput(embedMany),
      mode: 'auto',
      providerBatchMinItems: 1,
    });
    expect(result.mode).toBe('provider_batch');
    expect(result.submitted).toBe(3);
    expect(result.status).toBe('running');
    expect(embedMany).not.toHaveBeenCalled();
    expect(finalizeArgs.status).toBe('running');
  });

  it('pauses a provider batch run when submission hits provider quota', async () => {
    const { runEmbeddingBackfill, EmbeddingProviderError } = await loadEngine();
    supportsBatch = true;
    submitBatchImpl = async () => {
      throw new EmbeddingProviderError('provider_quota', 'no funds');
    };
    const result = await runEmbeddingBackfill({
      ...baseInput(vi.fn()),
      mode: 'provider_batch',
    });
    expect(result.mode).toBe('provider_batch');
    expect(result.status).toBe('paused');
    expect(result.pauseReason).toBe('paused_provider_quota');
    expect(finalizeArgs.status).toBe('paused');
  });
});
