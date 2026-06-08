import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, desc, eq, or, sql } from 'drizzle-orm';

import { _setRuntimeStorageForTest } from '@core/adapters/storage/postgres/runtime-store.js';
import * as pgSchema from '@core/adapters/storage/postgres/schema/schema.js';
import { AppMemoryService } from '@core/memory/app-memory-service.js';
import { runEmbeddingBackfill } from '@core/memory/app-memory-backfill.js';
import { selectBackfillCandidates } from '@core/memory/app-memory-backfill-candidates.js';
import {
  markEmbeddingState,
  writeReadyEmbedding,
} from '@core/memory/app-memory-embedding-writes.js';
import { pollAndImportProviderBatches } from '@core/memory/app-memory-backfill-provider-batch.js';
import { queryAppMemoryItems } from '@core/memory/app-memory-recall.js';
import { embeddingContentHash } from '@core/memory/app-memory-service-helpers.js';
import type { EmbeddingProvider } from '@core/memory/memory-embeddings.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;
const DIMENSIONS = 1536;
const USER_ID = 'user-semantic-1';
const AGENT_ID = 'agent-semantic';

/** Deterministic one-hot embedder: feline category vs vehicle category. */
function categoryVector(text: string): number[] {
  const vector = new Array(DIMENSIONS).fill(0);
  if (/felin|\bcat\b|kitten|purr|pet/i.test(text)) vector[0] = 1;
  else if (/auto|\bcar\b|vehicle|engine|commute/i.test(text)) vector[1] = 1;
  else vector[2] = 1;
  return vector;
}

const fakeProvider: EmbeddingProvider = {
  isEnabled: () => true,
  validateConfiguration: () => undefined,
  expectedDimensions: () => DIMENSIONS,
  embedMany: async (texts) => texts.map((text) => categoryVector(text)),
  embedOne: async (text) => categoryVector(text),
};

function recallDeps(withEmbeddings: boolean) {
  const base = {
    schema: {
      memoryItemsPostgres: pgSchema.memoryItemsPostgres,
      memoryRecallEventsPostgres: pgSchema.memoryRecallEventsPostgres,
    },
    sqlOps: { and, asc, desc, eq, or, sql },
  };
  if (!withEmbeddings) return base;
  return {
    ...base,
    embeddings: {
      enabled: true,
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions: DIMENSIONS,
      memoryItemEmbeddingsPostgres: pgSchema.memoryItemEmbeddingsPostgres,
      embedQuery: async (query: string) => categoryVector(query),
    },
  };
}

function backfillInput(runtime: PostgresIntegrationRuntime) {
  return {
    db: runtime.service.db,
    appId: 'default',
    agentId: AGENT_ID,
    trigger: 'cli' as const,
    provider: 'openai',
    model: 'text-embedding-3-small',
    dimensions: DIMENSIONS,
    batchSize: 16,
    dailyLimit: 500,
    maxItemsPerRun: 500,
    providerBatchMinItems: 100,
    mode: 'inline' as const,
    embeddingProvider: fakeProvider,
  };
}

maybeDescribe('semantic memory backfill + hybrid recall', () => {
  let runtime: PostgresIntegrationRuntime;
  let service: AppMemoryService;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'semantic_memory',
    });
    _setRuntimeStorageForTest(runtime.storageRuntime);
    AppMemoryService.resetForTest();
    service = new AppMemoryService(runtime.service.db);
    await service.save({
      appId: 'default',
      agentId: AGENT_ID,
      userId: USER_ID,
      kind: 'fact',
      key: 'pet-profile',
      value: 'feline companion that purrs softly',
      why: 'household animal',
      source: 'integration-test',
      confidence: 1,
    });
    await service.save({
      appId: 'default',
      agentId: AGENT_ID,
      userId: USER_ID,
      kind: 'fact',
      key: 'commute',
      value: 'fast automobile engine tuning',
      source: 'integration-test',
      confidence: 1,
    });
  }, 60_000);

  afterAll(async () => {
    AppMemoryService.resetForTest();
    await runtime.cleanup();
  });

  it('creates the partial HNSW index on memory_item_embeddings', async () => {
    const result = await runtime.service.pool.query(
      `select indexdef from pg_indexes where schemaname = $1 and indexname = 'idx_memory_item_embeddings_hnsw'`,
      [runtime.schemaName],
    );
    expect(result.rows).toHaveLength(1);
    expect(String(result.rows[0].indexdef)).toContain('hnsw');
    expect(String(result.rows[0].indexdef)).toContain('vector_cosine_ops');
  });

  it('backfills active memories and serves a semantic-only query', async () => {
    const backfill = await runEmbeddingBackfill(backfillInput(runtime));
    expect(backfill.status).toBe('completed');
    expect(backfill.indexed).toBe(2);

    // "kitten" shares no lexical token with "feline companion" yet must match it.
    const rows = await queryAppMemoryItems(
      runtime.service.db,
      {
        appId: 'default',
        agentId: AGENT_ID,
        userId: USER_ID,
        query: 'kitten',
        limit: 5,
      },
      true,
      recallDeps(true) as never,
    );
    const top = rows[0];
    expect(top?.row.key).toBe('pet-profile');
    expect(top?.vectorScore).toBeGreaterThan(0);
    expect(top?.lexicalScore).toBe(0);
    expect(top?.reasons).toContain('semantic');
  });

  it('selects eligible rows past ready rows instead of starving at the scan limit', async () => {
    const prefix = `starvation-${Date.now()}`;
    const agentId = `${AGENT_ID}-starvation`;
    for (let index = 0; index < 3; index += 1) {
      await service.save({
        appId: 'default',
        agentId,
        userId: USER_ID,
        kind: 'fact',
        key: `${prefix}-${index}`,
        value: `value ${index}`,
        source: 'integration-test',
        confidence: 1,
      });
    }
    const rows = await runtime.service.db
      .select({
        id: pgSchema.memoryItemsPostgres.id,
        key: pgSchema.memoryItemsPostgres.key,
        valueJson: pgSchema.memoryItemsPostgres.valueJson,
      })
      .from(pgSchema.memoryItemsPostgres)
      .where(
        and(
          eq(pgSchema.memoryItemsPostgres.appId, 'default'),
          eq(pgSchema.memoryItemsPostgres.agentId, agentId),
          sql`${pgSchema.memoryItemsPostgres.key} like ${`${prefix}-%`}`,
        ),
      )
      .orderBy(asc(pgSchema.memoryItemsPostgres.updatedAt));
    expect(rows).toHaveLength(3);
    for (const row of rows.slice(0, 2)) {
      const valueJson = row.valueJson as {
        value?: string;
        why?: string | null;
      };
      await writeReadyEmbedding(
        runtime.service.db,
        {
          itemId: row.id,
          provider: 'openai',
          model: 'text-embedding-3-small',
          dimensions: DIMENSIONS,
          contentHash: embeddingContentHash({
            key: row.key,
            value: valueJson.value ?? '',
            why: valueJson.why ?? null,
          }),
        },
        categoryVector('ready row'),
        new Date().toISOString(),
      );
    }

    const scan = await selectBackfillCandidates(runtime.service.db, {
      appId: 'default',
      agentId,
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions: DIMENSIONS,
      scanLimit: 2,
      now: new Date().toISOString(),
    });

    expect(scan.candidates.map((candidate) => candidate.key)).toContain(
      `${prefix}-2`,
    );
  });

  it('ignores stale embedding results without pruning the current ready vector', async () => {
    const key = `stale-batch-${Date.now()}`;
    const agentId = `${AGENT_ID}-stale`;
    const oldItem = await service.save({
      appId: 'default',
      agentId,
      userId: USER_ID,
      kind: 'fact',
      key,
      value: 'old content for batch',
      source: 'integration-test',
      confidence: 1,
    });
    const oldHash = embeddingContentHash({
      key,
      value: oldItem.value,
      why: oldItem.why ?? null,
    });
    const newItem = await service.save({
      appId: 'default',
      agentId,
      userId: USER_ID,
      kind: 'fact',
      key,
      value: 'new content for batch',
      source: 'integration-test',
      confidence: 1,
    });
    const newHash = embeddingContentHash({
      key,
      value: newItem.value,
      why: newItem.why ?? null,
    });
    await expect(
      writeReadyEmbedding(
        runtime.service.db,
        {
          itemId: newItem.id,
          provider: 'openai',
          model: 'text-embedding-3-small',
          dimensions: DIMENSIONS,
          contentHash: newHash,
        },
        categoryVector('new content for batch'),
        new Date().toISOString(),
      ),
    ).resolves.toBe(true);

    await expect(
      writeReadyEmbedding(
        runtime.service.db,
        {
          itemId: oldItem.id,
          provider: 'openai',
          model: 'text-embedding-3-small',
          dimensions: DIMENSIONS,
          contentHash: oldHash,
        },
        categoryVector('old content for batch'),
        new Date().toISOString(),
      ),
    ).resolves.toBe(false);

    const readyRows = await runtime.service.db
      .select({
        contentHash: pgSchema.memoryItemEmbeddingsPostgres.contentHash,
      })
      .from(pgSchema.memoryItemEmbeddingsPostgres)
      .where(
        and(
          eq(pgSchema.memoryItemEmbeddingsPostgres.itemId, newItem.id),
          eq(pgSchema.memoryItemEmbeddingsPostgres.status, 'ready'),
        ),
      );
    expect(readyRows).toEqual([{ contentHash: newHash }]);
  });

  it('bounds provider batch polling and defers extra submitted batches', async () => {
    const agentId = `${AGENT_ID}-batch`;
    const batchRows = [];
    for (let index = 0; index < 2; index += 1) {
      const item = await service.save({
        appId: 'default',
        agentId,
        userId: USER_ID,
        kind: 'fact',
        key: `batch-${Date.now()}-${index}`,
        value: `batch value ${index}`,
        source: 'integration-test',
        confidence: 1,
      });
      const contentHash = embeddingContentHash({
        key: item.key,
        value: item.value,
        why: item.why ?? null,
      });
      await markEmbeddingState(
        runtime.service.db,
        {
          itemId: item.id,
          provider: 'openai',
          model: 'text-embedding-3-small',
          dimensions: DIMENSIONS,
          contentHash,
        },
        'submitted',
        new Date().toISOString(),
        { providerBatchId: `provider-batch-${index}` },
      );
      batchRows.push({ item, contentHash, batchId: `provider-batch-${index}` });
    }
    const polled: string[] = [];
    const provider: EmbeddingProvider = {
      ...fakeProvider,
      batch: {
        submitBatch: async () => ({ batchId: 'unused' }),
        pollBatch: async (batchId) => {
          polled.push(batchId);
          return {
            batchId,
            state: 'completed',
            outputFileId: 'out',
            errorFileId: null,
            error: null,
          };
        },
        fetchBatchResults: async (poll) => {
          const row = batchRows.find(
            (candidate) => candidate.batchId === poll.batchId,
          );
          return row
            ? [
                {
                  customId: row.item.id,
                  embedding: categoryVector(row.item.value),
                },
              ]
            : [];
        },
      },
    };

    const summary = await pollAndImportProviderBatches({
      db: runtime.service.db,
      provider,
      providerName: 'openai',
      model: 'text-embedding-3-small',
      maxBatches: 1,
    });

    expect(summary.batchesPolled).toBe(1);
    expect(summary.imported).toBe(1);
    expect(summary.deferred).toBe(1);
    expect(polled).toHaveLength(1);
  });

  it('keeps lexical recall working when embeddings are not supplied', async () => {
    const rows = await queryAppMemoryItems(
      runtime.service.db,
      {
        appId: 'default',
        agentId: AGENT_ID,
        userId: USER_ID,
        query: 'automobile',
        limit: 5,
      },
      true,
      recallDeps(false) as never,
    );
    expect(rows.map((r) => r.row.key)).toContain('commute');
    expect(rows.every((r) => r.vectorScore === 0)).toBe(true);
  });

  it('falls back to lexical recall when query embedding exceeds the live deadline', async () => {
    const started = Date.now();
    const rows = await queryAppMemoryItems(
      runtime.service.db,
      {
        appId: 'default',
        agentId: AGENT_ID,
        userId: USER_ID,
        query: 'automobile',
        limit: 5,
      },
      true,
      {
        ...recallDeps(false),
        embeddings: {
          enabled: true,
          provider: 'openai',
          model: 'text-embedding-3-small',
          dimensions: DIMENSIONS,
          memoryItemEmbeddingsPostgres: pgSchema.memoryItemEmbeddingsPostgres,
          embedQuery: async (_query: string, signal?: AbortSignal) =>
            new Promise<null>((_resolve, reject) => {
              signal?.addEventListener(
                'abort',
                () => reject(new Error('aborted by test')),
                { once: true },
              );
            }),
        },
      } as never,
    );

    expect(Date.now() - started).toBeLessThan(3000);
    expect(rows.map((row) => row.row.key)).toContain('commute');
    expect(rows.every((row) => row.vectorScore === 0)).toBe(true);
  });

  it('re-embeds only the changed item on a value update', async () => {
    await service.save({
      appId: 'default',
      agentId: AGENT_ID,
      userId: USER_ID,
      kind: 'fact',
      key: 'pet-profile',
      value: 'feline companion that purrs loudly now',
      why: 'household animal',
      source: 'integration-test',
      confidence: 1,
    });
    const itemRows = await runtime.service.db
      .select({ id: pgSchema.memoryItemsPostgres.id })
      .from(pgSchema.memoryItemsPostgres)
      .where(
        and(
          eq(pgSchema.memoryItemsPostgres.appId, 'default'),
          eq(pgSchema.memoryItemsPostgres.key, 'pet-profile'),
          eq(pgSchema.memoryItemsPostgres.status, 'active'),
        ),
      );
    const itemId = itemRows[0]!.id;

    const before = await runtime.service.db
      .select({ status: pgSchema.memoryItemEmbeddingsPostgres.status })
      .from(pgSchema.memoryItemEmbeddingsPostgres)
      .where(
        and(
          eq(pgSchema.memoryItemEmbeddingsPostgres.itemId, itemId),
          eq(pgSchema.memoryItemEmbeddingsPostgres.status, 'ready'),
        ),
      );
    // Stale ready row still present until re-embedded.
    expect(before.length).toBeGreaterThanOrEqual(1);

    const pendingScan = await selectBackfillCandidates(runtime.service.db, {
      appId: 'default',
      agentId: AGENT_ID,
      provider: 'openai',
      model: 'text-embedding-3-small',
      dimensions: DIMENSIONS,
      scanLimit: 10,
      now: new Date().toISOString(),
    });
    expect(pendingScan.candidates.map((candidate) => candidate.key)).toEqual([
      'pet-profile',
    ]);

    const rerun = await runEmbeddingBackfill(backfillInput(runtime));
    expect(rerun.indexed).toBe(1); // only the changed item re-embeds

    const after = await runtime.service.db
      .select({
        contentHash: pgSchema.memoryItemEmbeddingsPostgres.contentHash,
      })
      .from(pgSchema.memoryItemEmbeddingsPostgres)
      .where(
        and(
          eq(pgSchema.memoryItemEmbeddingsPostgres.itemId, itemId),
          eq(pgSchema.memoryItemEmbeddingsPostgres.status, 'ready'),
        ),
      );
    // Sibling pruning keeps exactly one ready row for the item's current text.
    expect(after).toHaveLength(1);
  });
});
