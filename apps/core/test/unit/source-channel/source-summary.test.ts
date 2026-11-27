import { createSourceModelSnapshot } from '../../../src/shared/source-model-snapshot.js';
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as catalog from '../../../src/shared/model-catalog.js';
afterEach(() => vi.restoreAllMocks());
import { prepareSourceSummary } from '../../../src/runtime/source-discussion-summary.js';
const pin = () => {
  const model = catalog.resolveModelSelectionForWorkload('haiku', 'chat');
  if (!model.ok) throw new Error('Fixture model missing');
  return createSourceModelSnapshot('haiku', model.entry);
};
describe('source scoped summary', () => {
  it('checks fresh execution authority before token counting and again after slow preparation', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const calls: string[] = [];
    let grantUntil = now;
    const text = await prepareSourceSummary({
      answer: {
        id: 'a',
        claimToken: 'c',
        request: { model: 'haiku' } as never,
        modelSnapshot: pin(),
        messages: [],
        selectedSourceIds: ['M1'],
        summaryWork: {
          id: 'digest',
          mode: 'recent',
          generation: 1,
          workspaceId: 'W1',
          sourceVersion: 'R1',
          profileVersion: 'v1',
          sourceIds: ['M1'],
          throughPosition: '1',
          messages: [
            {
              id: 'M1',
              content: 'Exact context',
              chat_jid: 'D1',
              sender: 'p',
              sender_name: 'P',
              timestamp: '2026-11-17',
            },
          ],
        },
      },
      appId: 'app' as never,
      deadline: now + 180000,
      onFirstProviderCall: async () => {
        calls.push('authority');
        grantUntil = Date.now() + 5000;
      },
      client: {
        isConfigured: () => true,
        countTokens: async () => {
          expect(grantUntil).toBeGreaterThan(Date.now());
          calls.push('count');
          vi.mocked(Date.now).mockReturnValue(now + 6000);
          return 100;
        },
        query: async () => {
          expect(grantUntil).toBeGreaterThan(Date.now());
          calls.push('query');
          return JSON.stringify({ summary: 'Preserved exact context' });
        },
      },
      repository: {
        readSourceSummary: async () => undefined,
        saveSourceSummary: async (value) => value.text,
      },
    });
    expect(text).toBe('Preserved exact context');
    expect(calls).toEqual(['authority', 'count', 'authority', 'query']);
  });
  it('does not contact the token counter after fresh execution authority is denied', async () => {
    let providerCalls = 0;
    await expect(
      prepareSourceSummary({
        answer: {
          id: 'a',
          claimToken: 'c',
          request: { model: 'haiku' } as never,
          modelSnapshot: pin(),
          messages: [],
          selectedSourceIds: [],
        },
        appId: 'app' as never,
        deadline: Date.now() + 180000,
        onFirstProviderCall: async () => {
          throw new Error('Fresh execution authority denied');
        },
        client: {
          isConfigured: () => true,
          query: async () => '',
          countTokens: async () => {
            providerCalls++;
            return 100;
          },
        },
        repository: {},
      }),
    ).rejects.toThrow('Fresh execution authority denied');
    expect(providerCalls).toBe(0);
  });
  it.each(['anthropic', 'openai'])(
    'summarizes exact sources on configured %s route and preserves coverage',
    async (route) => {
      const selected = catalog.resolveModelSelectionForWorkload(
        'haiku',
        'chat',
      );
      if (!selected.ok) throw new Error('Catalog fixture missing');
      const runnerModel =
        route === 'openai' ? 'gpt-6-luna' : selected.entry.runnerModel;
      vi.spyOn(catalog, 'resolveModelSelectionForWorkload').mockReturnValue({
        ...selected,
        entry: {
          ...selected.entry,
          runnerModel,
          responseFamily: route,
          modelRoute: { ...selected.entry.modelRoute, id: route },
        },
      } as never);
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
      const countTokens = vi.fn(async () => 100);
      const text = await prepareSourceSummary({
        answer: {
          id: 'a',
          claimToken: 'c',
          request: { model: 'haiku' } as never,
          modelSnapshot: pin(),
          messages: [],
          selectedSourceIds: ['M1', 'M2'],
          summaryWork: work,
        },
        appId: 'app' as never,
        deadline: Date.now() + 180000,
        client: {
          query,
          countTokens,
          isConfigured: () => true,
        },
        repository: {
          readSourceSummary: async () => undefined,
          saveSourceSummary: save,
        },
      });
      expect(text).toContain('Earlier decision');
      expect(countTokens.mock.calls[0][0]).toMatchObject({
        model: runnerModel,
        modelProfile: { modelRoute: route, alias: 'haiku' },
      });
      expect(query).toHaveBeenCalledTimes(1);
      expect(query.mock.calls[0][0].prompt).toContain('Exact parent');
      expect(query.mock.calls[0][0].model).toBe(runnerModel);
      expect(query.mock.calls[0][0].modelProfile.modelRoute).toBe(route);
      expect(query.mock.calls[0][0]).not.toHaveProperty('reasoningEffort');
      expect(query.mock.calls[0][0].toolPolicy).toBe('none');
      expect(query.mock.calls[0][0].maxOutputTokens).toBe(4096);
      expect(save.mock.calls[0][0].work.sourceIds).toEqual(['M1']);
    },
  );
  it('reuses a durable exact digest without another provider call', async () => {
    const query = vi.fn();
    const save = vi.fn();
    const text = await prepareSourceSummary({
      answer: {
        id: 'a',
        claimToken: 'c',
        request: { model: 'haiku' } as never,
        modelSnapshot: pin(),
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
  it('counts the current input budget even when a durable digest is cached', async () => {
    const query = vi.fn();
    const countTokens = vi.fn(async () => 100001);
    await expect(
      prepareSourceSummary({
        answer: {
          id: 'a',
          claimToken: 'c',
          request: { model: 'haiku' } as never,
          modelSnapshot: pin(),
          messages: [{ content: 'large current source' }] as never,
          selectedSourceIds: [],
          summaryWork: { id: 'digest1' } as never,
        },
        appId: 'app' as never,
        deadline: Date.now() + 10000,
        client: { query, countTokens, isConfigured: () => true },
        repository: {
          readSourceSummary: async () => 'cached digest',
          saveSourceSummary: vi.fn(),
        },
      }),
    ).rejects.toThrow('100000-token');
    expect(query).not.toHaveBeenCalled();
    expect(countTokens.mock.calls[0][0].prompt).toContain('cached digest');
    expect(countTokens.mock.calls[0][0].prompt).toContain(
      'large current source',
    );
  });
  it('makes no call when the active execution budget is exhausted', async () => {
    const query = vi.fn();
    await expect(
      prepareSourceSummary({
        answer: {
          id: 'a',
          claimToken: 'c',
          request: { model: 'haiku' } as never,
          modelSnapshot: pin(),
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
      modelSnapshot: pin(),
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
