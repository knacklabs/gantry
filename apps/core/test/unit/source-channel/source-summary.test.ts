import { describe, it, expect, vi } from 'vitest';
import { prepareSourceSummary } from '../../../src/runtime/source-discussion-summary.js';
describe('source scoped summary', () => {
  it('summarizes exact supplied sources with Haiku and saves coverage independently of answer success', async () => {
    const query = vi.fn(async () =>
      JSON.stringify({ summary: 'Earlier decision: check both stages.' }),
    );
    const save = vi.fn(async (input) => input.text);
    const work = {
      id: 'digest1',
      mode: 'ancestry' as const,
      generation: 1,
      workspaceId: 'W1',
      sourceVersion: 'R1',
      profileVersion: 'v1',
      sourceIds: ['M1'],
      throughPosition: '1',
      messages: [
        {
          id: 'M1',
          content: 'Exact parent',
          chat_jid: 'D1',
          sender: 'p',
          sender_name: 'P',
          timestamp: '2026-11-17',
        },
      ],
    };
    const text = await prepareSourceSummary({
      answer: {
        id: 'a',
        claimToken: 'c',
        request: { model: 'haiku' } as never,
        messages: [],
        selectedSourceIds: ['M1', 'M2'],
        summaryWork: work,
      },
      appId: 'app' as never,
      deadline: Date.now() + 180000,
      client: { query, countTokens: async () => 100, isConfigured: () => true },
      repository: {
        readSourceSummary: async () => undefined,
        saveSourceSummary: save,
      },
    });
    expect(text).toContain('Earlier decision');
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0].prompt).toContain('Exact parent');
    expect(query.mock.calls[0][0].model).toMatch(/^claude-haiku-4-5/);
    expect(query.mock.calls[0][0]).not.toHaveProperty('reasoningEffort');
    expect(save.mock.calls[0][0].work.sourceIds).toEqual(['M1']);
  });
  it('reuses a durable exact digest without another provider call', async () => {
    const query = vi.fn();
    const save = vi.fn();
    const text = await prepareSourceSummary({
      answer: {
        id: 'a',
        claimToken: 'c',
        request: { model: 'haiku' } as never,
        messages: [],
        selectedSourceIds: [],
        summaryWork: { id: 'digest1' } as never,
      },
      appId: 'app' as never,
      deadline: Date.now() + 1000,
      client: { query, countTokens: async () => 100, isConfigured: () => true },
      repository: {
        readSourceSummary: async () => 'saved exact digest',
        saveSourceSummary: save,
      },
    });
    expect(text).toBe('saved exact digest');
    expect(query).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });
  it('makes no call when the active execution budget is exhausted', async () => {
    const query = vi.fn();
    await expect(
      prepareSourceSummary({
        answer: {
          id: 'a',
          claimToken: 'c',
          request: { model: 'haiku' } as never,
          messages: [],
          selectedSourceIds: [],
          summaryWork: {
            id: 'digest1',
            messages: [{ content: 'x' }],
            sourceIds: ['M1'],
          } as never,
        },
        appId: 'app' as never,
        deadline: Date.now() - 1,
        client: {
          query,
          countTokens: async () => 100,
          isConfigured: () => true,
        },
        repository: {
          readSourceSummary: async () => undefined,
          saveSourceSummary: vi.fn(),
        },
      }),
    ).rejects.toThrow(/budget/);
    expect(query).not.toHaveBeenCalled();
  });
  it('uses measured provider tokens rather than character length below eighty messages', async () => {
    const messages = Array.from({ length: 30 }, (_, i) => ({
      id: `M${i + 1}`,
      content: 'small multilingual source',
      chat_jid: 'D1',
      sender: 'p',
      sender_name: 'P',
      timestamp: '2026-11-17',
    }));
    const work = {
      id: 'token-digest',
      mode: 'recent' as const,
      generation: 1,
      workspaceId: 'W1',
      sourceVersion: 'R1',
      profileVersion: 'v1',
      sourceIds: messages.slice(0, 10).map((row) => row.id),
      throughPosition: '10',
      messages: messages.slice(0, 10),
    };
    const answer = {
      id: 'a',
      claimToken: 'c',
      request: { model: 'haiku' } as never,
      messages,
      selectedSourceIds: messages.map((row) => row.id),
      summaryCandidate: work,
    };
    const countTokens = vi.fn(async () => 9001);
    const query = vi.fn(async () =>
      JSON.stringify({ summary: 'Measured source summary' }),
    );
    const save = vi.fn(async (input) => input.text);
    await prepareSourceSummary({
      answer,
      appId: 'app' as never,
      deadline: Date.now() + 180000,
      client: { query, countTokens, isConfigured: () => true },
      repository: {
        readSourceSummary: async () => undefined,
        saveSourceSummary: save,
      },
    });
    expect(countTokens).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledTimes(1);
    expect(answer.messages).toHaveLength(20);
    expect(save.mock.calls[0][0].work.inputTokens).toBe(9001);
  });
});
