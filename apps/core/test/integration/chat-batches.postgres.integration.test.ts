import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AppId } from '@core/domain/app/app.js';
import { ChatBatchDailyCostLimitError } from '@core/domain/ports/chat-batches.js';
import type { MemoryLlmBatchCapability } from '@core/domain/ports/memory-llm-client.js';
import { ChatBatchStateMachine } from '@core/memory/chat-batch-state-machine.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;
const NOW = '2026-07-22T08:00:00.000Z';

maybeDescribe('chat batch Postgres durability', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'chat_batches',
    });
    for (const id of ['chat-batch-app', 'chat-budget-app', 'chat-retry-app']) {
      await runtime.repositories.apps.saveApp({
        id: id as never,
        slug: id,
        name: id,
        status: 'active',
        createdAt: NOW,
        updatedAt: NOW,
      });
    }
  }, 60_000);

  afterAll(async () => {
    if (runtime) await runtime.cleanup();
  });

  it('installs the recovery, correlation, accounting, and attention contract', async () => {
    const columns = await runtime.service.pool.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = 'chat_batches'
       ORDER BY ordinal_position`,
      [runtime.schemaName],
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual(
      expect.arrayContaining([
        'gantry_batch_correlation_id',
        'content_hash',
        'provider_batch_id',
        'request_snapshot',
        'result_snapshot',
        'reserved_cost_usd',
        'input_tokens',
        'output_tokens',
        'estimated_cost_usd',
        'attention_required',
      ]),
    );
    const indexes = await runtime.service.pool.query<{ indexname: string }>(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = $1 AND tablename = 'chat_batches'`,
      [runtime.schemaName],
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual(
      expect.arrayContaining([
        'chat_batches_correlation_unique',
        'chat_batches_provider_batch_unique',
        'idx_chat_batches_recovery',
      ]),
    );
  });

  it('runs submit, poll, and atomic result/accounting apply through real persistence', async () => {
    const capability = fixtureCapability();
    const machine = new ChatBatchStateMachine({
      repository: runtime.repositories.chatBatches,
      resolveCapability: () => capability,
      now: () => new Date(NOW),
      createId: () => 'postgres-e2e',
    });

    const submitted = await machine.submit({
      appId: 'chat-batch-app' as AppId,
      providerId: 'openai',
      model: 'gpt-test',
      correlationId: 'postgres-correlation',
      requests: [{ customId: 'page-1', prompt: 'Inspect page one' }],
      maxOutputTokens: 500,
      reservedCostUsd: 0.2,
      dailyCostLimitUsd: 1,
    });
    expect(submitted).toMatchObject({
      state: 'submitted',
      submitAttempts: 1,
      providerBatchId: 'provider-batch',
    });

    const applied = await machine.pollAndApply({ batchId: submitted.id });
    expect(applied).toMatchObject({
      state: 'applied',
      resultAttempts: 1,
      attentionRequired: false,
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        estimatedCostUsd: 0.02,
      },
    });
    expect(
      (await runtime.repositories.chatBatches.findById(submitted.id))
        ?.resultSnapshot,
    ).toEqual([
      {
        customId: 'page-1',
        text: '{"insight":true}',
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          provider_reported_cost_usd: 0.02,
        },
      },
    ]);
  });

  it('serializes concurrent reservations under the persisted daily cost cap', async () => {
    const repo = runtime.repositories.chatBatches;
    const create = (id: string) =>
      repo.createIntent({
        id,
        appId: 'chat-budget-app',
        providerId: 'openai',
        model: 'gpt-test',
        correlationId: `correlation-${id}`,
        contentHash: 'a'.repeat(64),
        requestSnapshot: [{ customId: id, prompt: 'test' }],
        requestCount: 1,
        snapshotBytes: 32,
        reservedCostUsd: 0.6,
        dailyCostLimitUsd: 1,
        dayStartIso: '2026-07-22T00:00:00.000Z',
        dayEndIso: '2026-07-23T00:00:00.000Z',
        nowIso: NOW,
      });
    const settled = await Promise.allSettled([
      create('budget-a'),
      create('budget-b'),
    ]);
    expect(
      settled.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const rejected = settled.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: expect.any(ChatBatchDailyCostLimitError),
    });
  });

  it('reopens a preflight failure without consuming the daily reservation', async () => {
    const capability = fixtureCapability();
    vi.mocked(capability.preflightBatch).mockRejectedValueOnce(
      new Error('credential temporarily unavailable'),
    );
    const machine = new ChatBatchStateMachine({
      repository: runtime.repositories.chatBatches,
      resolveCapability: () => capability,
      now: () => new Date(NOW),
      createId: () => 'postgres-retry',
    });
    const input = {
      appId: 'chat-retry-app' as AppId,
      providerId: 'openai',
      model: 'gpt-test',
      correlationId: 'postgres-retry-correlation',
      requests: [{ customId: 'page-1', prompt: 'Inspect page one' }],
      maxOutputTokens: 500,
      reservedCostUsd: 0.5,
      dailyCostLimitUsd: 0.5,
    };

    await expect(machine.submit(input)).rejects.toThrow(
      'credential temporarily unavailable',
    );
    expect(
      await runtime.repositories.chatBatches.findByCorrelationId({
        appId: input.appId,
        providerId: input.providerId,
        correlationId: input.correlationId,
      }),
    ).toMatchObject({ state: 'preflight_failed' });
    await expect(machine.submit(input)).resolves.toMatchObject({
      state: 'submitted',
    });
  });
});

function fixtureCapability(): MemoryLlmBatchCapability {
  return {
    preflightBatch: vi.fn(async () => undefined),
    submitBatch: vi.fn(async (opts) => {
      await opts.onSubmissionStart();
      return { batchId: 'provider-batch' };
    }),
    pollBatch: vi.fn(async () => ({
      batchId: 'provider-batch',
      state: 'completed' as const,
    })),
    fetchBatchResults: vi.fn(async () => [
      {
        customId: 'page-1',
        text: '{"insight":true}',
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          provider_reported_cost_usd: 0.02,
        },
      },
    ]),
    findBatchByCorrelationId: vi.fn(async () => null),
  };
}
