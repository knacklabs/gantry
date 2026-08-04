import { describe, expect, it, vi } from 'vitest';

import type { AppId } from '@core/domain/app/app.js';
import { CredentialBrokerPolicyError } from '@core/domain/models/credential-errors.js';
import type {
  ChatBatchIntentCreate,
  ChatBatchRecord,
  ChatBatchRepository,
  ChatBatchUsage,
} from '@core/domain/ports/chat-batches.js';
import type { MemoryLlmBatchCapability } from '@core/domain/ports/memory-llm-client.js';
import {
  ChatBatchStateMachine,
  type ChatBatchSubmitInput,
} from '@core/memory/chat-batch-state-machine.js';
import {
  resolveChatBatchMode,
  supportsChatBatch,
} from '@core/memory/chat-batch-mode.js';

const APP_ID = 'app_test' as AppId;
const NOW = new Date('2026-07-22T01:00:00.000Z');

describe('ChatBatchStateMachine', () => {
  it('enters prefer-orphan only after upload and completes the happy submission path', async () => {
    const events: string[] = [];
    const repository = new InMemoryChatBatchRepository(events);
    const capability = fixtureCapability(events);
    const machine = fixtureMachine(repository, capability);

    const submitted = await machine.submit(submitInput());
    expect(submitted.state).toBe('submitted');
    expect(events.slice(0, 6)).toEqual([
      'provider_preflight',
      'intent',
      'provider_upload',
      'submission_unknown',
      'provider_create',
      'submitted',
    ]);

    const applied = await machine.pollAndApply({ batchId: submitted.id });
    expect(applied.state).toBe('applied');
    expect(applied.resultSnapshot).toEqual([
      {
        customId: 'request-1',
        text: '{"ok":true}',
        usage: {
          input_tokens: 20,
          output_tokens: 5,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 2,
          provider_reported_cost_usd: 0.04,
        },
      },
    ]);
    expect(applied.usage).toEqual({
      inputTokens: 20,
      outputTokens: 5,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
      estimatedCostUsd: 0.04,
    });
    expect(events).toContain('applied');
  });

  it('keeps upload failures retryable without entering prefer-orphan', async () => {
    const events: string[] = [];
    const repository = new InMemoryChatBatchRepository(events);
    const capability = fixtureCapability(events);
    vi.mocked(capability.submitBatch).mockImplementationOnce(async () => {
      events.push('provider_upload');
      throw new Error('input upload failed');
    });
    const machine = fixtureMachine(repository, capability);

    await expect(machine.submit(submitInput())).rejects.toThrow(
      'input upload failed',
    );
    expect(repository.only()).toMatchObject({
      state: 'preflight_failed',
      providerBatchId: null,
      lastError: 'input upload failed',
    });
    expect(events).toEqual(['provider_preflight', 'intent', 'provider_upload']);
  });

  it('enters prefer-orphan after upload when provider batch creation fails and never auto-resubmits', async () => {
    const repository = new InMemoryChatBatchRepository();
    const capability = fixtureCapability();
    vi.mocked(capability.submitBatch).mockImplementationOnce(async (opts) => {
      // Upload has succeeded; the provider batch create is the first ambiguous
      // operation and must transition before it is sent.
      await opts.onSubmissionStart();
      throw new Error('connection lost during provider batch create');
    });
    const machine = fixtureMachine(repository, capability);

    await expect(machine.submit(submitInput())).rejects.toThrow(
      'connection lost during provider batch create',
    );
    await expect(machine.submit(submitInput())).resolves.toMatchObject({
      state: 'submission_unknown',
      attentionRequired: true,
    });
    expect(capability.submitBatch).toHaveBeenCalledTimes(1);

    const reconciled = await machine.reconcileSubmissionUnknown();
    expect(reconciled).toEqual({
      inspected: 1,
      adopted: 0,
      abandoned: 0,
      unresolved: 1,
    });
    expect(capability.submitBatch).toHaveBeenCalledTimes(1);
  });

  it('adopts a metadata-matched provider orphan through read-only reconciliation', async () => {
    const repository = new InMemoryChatBatchRepository();
    const capability = fixtureCapability();
    vi.mocked(capability.submitBatch).mockImplementationOnce(async (opts) => {
      await opts.onSubmissionStart();
      throw new Error('provider outcome unknown');
    });
    vi.mocked(capability.findBatchByCorrelationId).mockResolvedValue({
      batchId: 'provider-adopted',
    });
    const machine = fixtureMachine(repository, capability);

    await expect(machine.submit(submitInput())).rejects.toThrow();
    await expect(machine.reconcileSubmissionUnknown()).resolves.toEqual({
      inspected: 1,
      adopted: 1,
      abandoned: 0,
      unresolved: 0,
    });
    expect(repository.only().providerBatchId).toBe('provider-adopted');
    expect(repository.only().state).toBe('submitted');
    expect(capability.submitBatch).toHaveBeenCalledTimes(1);
  });

  it('persists result-download failures and stops at the retry ceiling', async () => {
    const repository = new InMemoryChatBatchRepository();
    const capability = fixtureCapability();
    vi.mocked(capability.fetchBatchResults).mockRejectedValue(
      new SyntaxError('invalid JSONL result line'),
    );
    const machine = fixtureMachine(repository, capability, { retryLimit: 2 });
    const submitted = await machine.submit(submitInput());

    const first = await machine.pollAndApply({ batchId: submitted.id });
    expect(first).toMatchObject({
      state: 'processing',
      resultAttempts: 1,
      lastError: 'invalid JSONL result line',
    });
    const second = await machine.pollAndApply({ batchId: submitted.id });
    expect(second).toMatchObject({
      state: 'failed',
      resultAttempts: 2,
      attentionRequired: true,
    });
    expect(second.resultSnapshot).toBeNull();
  });

  it('rejects incomplete result downloads before apply', async () => {
    const repository = new InMemoryChatBatchRepository();
    const capability = fixtureCapability();
    vi.mocked(capability.fetchBatchResults).mockResolvedValue([]);
    const machine = fixtureMachine(repository, capability);
    const submitted = await machine.submit(submitInput());

    const result = await machine.pollAndApply({ batchId: submitted.id });
    expect(result.state).toBe('processing');
    expect(result.lastError).toContain('result set is incomplete');
    expect(result.resultSnapshot).toBeNull();
  });

  it('abandons an unmatched unknown only after provider retention expires', async () => {
    const repository = new InMemoryChatBatchRepository();
    const capability = fixtureCapability();
    vi.mocked(capability.submitBatch).mockImplementationOnce(async (opts) => {
      await opts.onSubmissionStart();
      throw new Error('provider outcome unknown');
    });
    let clock = NOW;
    const machine = fixtureMachine(repository, capability, {
      now: () => clock,
      retentionMsForProvider: () => 1_000,
    });
    await expect(machine.submit(submitInput())).rejects.toThrow();

    clock = new Date(NOW.getTime() + 1_001);
    await expect(machine.reconcileSubmissionUnknown()).resolves.toEqual({
      inspected: 1,
      adopted: 0,
      abandoned: 1,
      unresolved: 0,
    });
    expect(repository.only()).toMatchObject({
      state: 'abandoned',
      attentionRequired: true,
    });
  });

  it('enforces the immutable snapshot byte limit before persistence', async () => {
    const repository = new InMemoryChatBatchRepository();
    const capability = fixtureCapability();
    const machine = fixtureMachine(repository, capability, {
      maxSnapshotBytes: 10,
    });

    await expect(machine.submit(submitInput())).rejects.toThrow(
      'Chat batch snapshot is',
    );
    expect(repository.rows.size).toBe(0);
    expect(capability.submitBatch).not.toHaveBeenCalled();
  });

  it('records deterministic pre-send failures as retryable, never unknown', async () => {
    const repository = new InMemoryChatBatchRepository();
    const capability = fixtureCapability();
    vi.mocked(capability.preflightBatch).mockRejectedValueOnce(
      new Error('model credential is missing'),
    );
    const machine = fixtureMachine(repository, capability);

    await expect(machine.submit(submitInput())).rejects.toThrow(
      'model credential is missing',
    );
    expect(repository.only()).toMatchObject({
      state: 'preflight_failed',
      attentionRequired: true,
      lastError: 'model credential is missing',
    });
    expect(repository.reservedCost()).toBe(0);

    await expect(machine.submit(submitInput())).resolves.toMatchObject({
      state: 'submitted',
    });
    expect(capability.submitBatch).toHaveBeenCalledTimes(1);
  });

  it('rejects credential-policy-ineligible batches before creating an intent', async () => {
    const repository = new InMemoryChatBatchRepository();
    const capability = fixtureCapability();
    vi.mocked(capability.preflightBatch).mockRejectedValueOnce(
      new CredentialBrokerPolicyError(
        'Anthropic claude_code_oauth does not support chat batches',
      ),
    );
    const machine = fixtureMachine(repository, capability);

    await expect(machine.submit(submitInput())).rejects.toThrow(
      'does not support chat batches',
    );
    expect(repository.rows.size).toBe(0);
  });

  it('includes maxOutputTokens in the durable snapshot and provider submission', async () => {
    const repository = new InMemoryChatBatchRepository();
    const capability = fixtureCapability();
    const machine = fixtureMachine(repository, capability);

    const submitted = await machine.submit({
      ...submitInput(),
      maxOutputTokens: 777,
    });

    expect(submitted.requestSnapshot).toEqual([
      expect.objectContaining({
        customId: 'request-1',
        maxOutputTokens: 777,
      }),
    ]);
    expect(capability.preflightBatch).toHaveBeenCalledWith(
      expect.objectContaining({ maxOutputTokens: 777 }),
    );
    expect(capability.submitBatch).toHaveBeenCalledWith(
      expect.objectContaining({ maxOutputTokens: 777 }),
    );
  });

  it('persists provider results in immutable request order', async () => {
    const repository = new InMemoryChatBatchRepository();
    const capability = fixtureCapability();
    vi.mocked(capability.fetchBatchResults).mockResolvedValue([
      { customId: 'request-2', text: 'second' },
      { customId: 'request-1', text: 'first' },
    ]);
    const machine = fixtureMachine(repository, capability);
    const submitted = await machine.submit({
      ...submitInput(),
      requests: [
        { customId: 'request-1', prompt: 'first' },
        { customId: 'request-2', prompt: 'second' },
      ],
    });

    const applied = await machine.pollAndApply({ batchId: submitted.id });

    expect(applied.resultSnapshot?.map((row) => row.customId)).toEqual([
      'request-1',
      'request-2',
    ]);
  });
});

describe('chat batch capability and mode selection', () => {
  it('detects only declared batch capability', () => {
    expect(
      supportsChatBatch({ batch: { supportedCredentialModes: ['api_key'] } }),
    ).toBe(true);
    expect(supportsChatBatch({})).toBe(false);
  });

  it('defaults off and falls back live for non-capable providers', () => {
    expect(
      resolveChatBatchMode({
        mode: 'provider_batch',
        itemCount: 1_000,
        provider: { batch: { supportedCredentialModes: ['api_key'] } },
      }),
    ).toBe('inline');
    expect(
      resolveChatBatchMode({
        enabled: true,
        mode: 'provider_batch',
        itemCount: 1_000,
        provider: {},
      }),
    ).toBe('inline');
  });

  it('applies the auto threshold while explicit provider_batch bypasses it', () => {
    expect(
      resolveChatBatchMode({
        enabled: true,
        mode: 'auto',
        itemCount: 99,
        minItems: 100,
        provider: { batch: { supportedCredentialModes: ['api_key'] } },
      }),
    ).toBe('inline');
    expect(
      resolveChatBatchMode({
        enabled: true,
        mode: 'auto',
        itemCount: 100,
        minItems: 100,
        provider: { batch: { supportedCredentialModes: ['api_key'] } },
      }),
    ).toBe('provider_batch');
    expect(
      resolveChatBatchMode({
        enabled: true,
        mode: 'provider_batch',
        itemCount: 1,
        provider: { batch: { supportedCredentialModes: ['api_key'] } },
      }),
    ).toBe('provider_batch');
  });
});

function submitInput(): ChatBatchSubmitInput {
  return {
    appId: APP_ID,
    providerId: 'openai',
    model: 'gpt-test',
    correlationId: 'correlation-1',
    requests: [{ customId: 'request-1', prompt: 'Inspect this page' }],
    maxOutputTokens: 500,
    reservedCostUsd: 0.1,
    dailyCostLimitUsd: 1,
  };
}

function fixtureCapability(events: string[] = []): MemoryLlmBatchCapability {
  return {
    preflightBatch: vi.fn(async () => {
      events.push('provider_preflight');
    }),
    submitBatch: vi.fn(async (opts) => {
      events.push('provider_upload');
      await opts.onSubmissionStart();
      events.push('provider_create');
      return { batchId: 'provider-batch-1' };
    }),
    pollBatch: vi.fn(async () => ({
      batchId: 'provider-batch-1',
      state: 'completed' as const,
    })),
    fetchBatchResults: vi.fn(async () => [
      {
        customId: 'request-1',
        text: '{"ok":true}',
        usage: {
          input_tokens: 20,
          output_tokens: 5,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 2,
          provider_reported_cost_usd: 0.04,
        },
      },
    ]),
    findBatchByCorrelationId: vi.fn(async () => null),
  };
}

function fixtureMachine(
  repository: InMemoryChatBatchRepository,
  capability: MemoryLlmBatchCapability,
  overrides: Partial<
    ConstructorParameters<typeof ChatBatchStateMachine>[0]
  > = {},
): ChatBatchStateMachine {
  return new ChatBatchStateMachine({
    repository,
    resolveCapability: () => capability,
    now: () => NOW,
    createId: () => 'batch-id',
    ...overrides,
  });
}

class InMemoryChatBatchRepository implements ChatBatchRepository {
  readonly rows = new Map<string, ChatBatchRecord>();

  constructor(private readonly events: string[] = []) {}

  async createIntent(input: ChatBatchIntentCreate): Promise<ChatBatchRecord> {
    const existing = [...this.rows.values()].find(
      (row) =>
        row.appId === input.appId &&
        row.providerId === input.providerId &&
        row.correlationId === input.correlationId,
    );
    if (existing) {
      if (existing.contentHash !== input.contentHash)
        throw new Error('hash mismatch');
      if (existing.state === 'preflight_failed') {
        return this.update(
          existing,
          {
            state: 'submission_intent',
            reservedCostUsd: input.reservedCostUsd,
            attentionRequired: false,
            lastError: null,
            createdAt: input.nowIso,
            updatedAt: input.nowIso,
          },
          'intent',
        );
      }
      return existing;
    }
    const row: ChatBatchRecord = {
      id: input.id,
      appId: input.appId,
      providerId: input.providerId,
      model: input.model,
      correlationId: input.correlationId,
      contentHash: input.contentHash,
      state: 'submission_intent',
      providerBatchId: null,
      requestSnapshot: input.requestSnapshot,
      resultSnapshot: null,
      requestCount: input.requestCount,
      snapshotBytes: input.snapshotBytes,
      reservedCostUsd: input.reservedCostUsd,
      usage: emptyUsage(),
      submitAttempts: 0,
      pollAttempts: 0,
      resultAttempts: 0,
      attentionRequired: false,
      lastError: null,
      submittedAt: null,
      appliedAt: null,
      createdAt: input.nowIso,
      updatedAt: input.nowIso,
    };
    this.rows.set(row.id, row);
    this.events.push('intent');
    return row;
  }

  async findById(id: string): Promise<ChatBatchRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async findByCorrelationId(input: {
    appId: string;
    providerId: string;
    correlationId: string;
  }): Promise<ChatBatchRecord | null> {
    return (
      [...this.rows.values()].find(
        (row) =>
          row.appId === input.appId &&
          row.providerId === input.providerId &&
          row.correlationId === input.correlationId,
      ) ?? null
    );
  }

  async listSubmissionUnknown(input: {
    appId?: string;
    limit: number;
  }): Promise<ChatBatchRecord[]> {
    return [...this.rows.values()]
      .filter(
        (row) =>
          row.state === 'submission_unknown' &&
          (!input.appId || row.appId === input.appId),
      )
      .slice(0, input.limit);
  }

  async recordPreflightFailure(
    input: ChatBatchIntentCreate & { error: string },
  ): Promise<ChatBatchRecord> {
    const existing = [...this.rows.values()].find(
      (row) =>
        row.appId === input.appId &&
        row.providerId === input.providerId &&
        row.correlationId === input.correlationId,
    );
    if (existing) {
      if (existing.contentHash !== input.contentHash)
        throw new Error('hash mismatch');
      return this.update(existing, {
        state: 'preflight_failed',
        attentionRequired: true,
        lastError: input.error,
        updatedAt: input.nowIso,
      });
    }
    const row: ChatBatchRecord = {
      id: input.id,
      appId: input.appId,
      providerId: input.providerId,
      model: input.model,
      correlationId: input.correlationId,
      contentHash: input.contentHash,
      state: 'preflight_failed',
      providerBatchId: null,
      requestSnapshot: input.requestSnapshot,
      resultSnapshot: null,
      requestCount: input.requestCount,
      snapshotBytes: input.snapshotBytes,
      reservedCostUsd: input.reservedCostUsd,
      usage: emptyUsage(),
      submitAttempts: 0,
      pollAttempts: 0,
      resultAttempts: 0,
      attentionRequired: true,
      lastError: input.error,
      submittedAt: null,
      appliedAt: null,
      createdAt: input.nowIso,
      updatedAt: input.nowIso,
    };
    this.rows.set(row.id, row);
    return row;
  }

  async markSubmissionUnknown(input: {
    id: string;
    nowIso: string;
  }): Promise<ChatBatchRecord | null> {
    const row = this.rows.get(input.id);
    if (!row || row.state !== 'submission_intent') return null;
    return this.update(
      row,
      {
        state: 'submission_unknown',
        submitAttempts: row.submitAttempts + 1,
        attentionRequired: true,
        lastError:
          'Provider submission outcome is unknown; reconciliation required',
        updatedAt: input.nowIso,
      },
      'submission_unknown',
    );
  }

  async markSubmitted(input: {
    id: string;
    providerBatchId: string;
    nowIso: string;
  }): Promise<ChatBatchRecord | null> {
    const row = this.rows.get(input.id);
    if (!row || row.state !== 'submission_unknown') return null;
    return this.update(
      row,
      {
        state: 'submitted',
        providerBatchId: input.providerBatchId,
        attentionRequired: false,
        lastError: null,
        submittedAt: input.nowIso,
        updatedAt: input.nowIso,
      },
      'submitted',
    );
  }

  async markProcessing(input: {
    id: string;
    nowIso: string;
  }): Promise<ChatBatchRecord | null> {
    const row = this.rows.get(input.id);
    if (!row || !['submitted', 'processing'].includes(row.state)) return null;
    return this.update(row, {
      state: 'processing',
      lastError: null,
      updatedAt: input.nowIso,
    });
  }

  async recordAttemptError(input: {
    id: string;
    phase: 'poll' | 'result';
    error: string;
    terminal: boolean;
    nowIso: string;
  }): Promise<ChatBatchRecord | null> {
    const row = this.rows.get(input.id);
    if (!row || !['submitted', 'processing'].includes(row.state)) return null;
    return this.update(row, {
      state: input.terminal ? 'failed' : row.state,
      pollAttempts:
        input.phase === 'poll' ? row.pollAttempts + 1 : row.pollAttempts,
      resultAttempts:
        input.phase === 'result' ? row.resultAttempts + 1 : row.resultAttempts,
      attentionRequired: input.terminal,
      lastError: input.error,
      updatedAt: input.nowIso,
    });
  }

  async applyResults(input: {
    id: string;
    results: readonly Record<string, unknown>[];
    usage: ChatBatchUsage;
    nowIso: string;
  }): Promise<ChatBatchRecord | null> {
    const row = this.rows.get(input.id);
    if (!row || !['submitted', 'processing'].includes(row.state)) return null;
    return this.update(
      row,
      {
        state: 'applied',
        resultSnapshot: input.results,
        usage: input.usage,
        resultAttempts: row.resultAttempts + 1,
        attentionRequired: false,
        lastError: null,
        appliedAt: input.nowIso,
        updatedAt: input.nowIso,
      },
      'applied',
    );
  }

  async abandonSubmission(input: {
    id: string;
    reason: string;
    nowIso: string;
  }): Promise<ChatBatchRecord | null> {
    const row = this.rows.get(input.id);
    if (!row || row.state !== 'submission_unknown') return null;
    return this.update(row, {
      state: 'abandoned',
      attentionRequired: true,
      lastError: input.reason,
      updatedAt: input.nowIso,
    });
  }

  only(): ChatBatchRecord {
    return [...this.rows.values()][0]!;
  }

  reservedCost(): number {
    return [...this.rows.values()]
      .filter((row) => row.state !== 'preflight_failed')
      .reduce((total, row) => total + row.reservedCostUsd, 0);
  }

  private update(
    row: ChatBatchRecord,
    patch: Partial<ChatBatchRecord>,
    event?: string,
  ): ChatBatchRecord {
    const updated = { ...row, ...patch };
    this.rows.set(row.id, updated);
    if (event) this.events.push(event);
    return updated;
  }
}

function emptyUsage(): ChatBatchUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCostUsd: null,
  };
}
