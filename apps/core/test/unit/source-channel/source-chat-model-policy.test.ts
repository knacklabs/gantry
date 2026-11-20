import { it, expect, vi } from 'vitest';
import { prepareSourceSummary } from '../../../src/runtime/source-discussion-summary.js';
import { resolveModelSelectionForWorkload } from '../../../src/shared/model-catalog.js';
import { sourceChatModelAllowed } from '../../../src/shared/source-chat-model-policy.js';
const model = (route: string, overrides = {}) =>
  ({
    modelRoute: { id: route },
    supportedWorkloads: ['chat'],
    capabilities: { toolUse: true, tokenAccounting: true },
    ...overrides,
  }) as never;
it('allows configured compatible providers without model-name or test-environment exceptions', () => {
  expect(
    sourceChatModelAllowed(model('openai', { runnerModel: 'gpt-6-luna' })),
  ).toBe(true);
  expect(
    sourceChatModelAllowed(
      model('anthropic', { runnerModel: 'claude-haiku-4-5-20251001' }),
    ),
  ).toBe(true);
});
it('rejects unknown routes and missing required workload or capabilities', () => {
  expect(sourceChatModelAllowed(model('unknown'))).toBe(false);
  expect(
    sourceChatModelAllowed(model('openai', { supportedWorkloads: [] })),
  ).toBe(false);
  expect(
    sourceChatModelAllowed(
      model('openai', {
        capabilities: { toolUse: false, tokenAccounting: true },
      }),
    ),
  ).toBe(false);
  expect(
    sourceChatModelAllowed(
      model('openai', {
        capabilities: { toolUse: true, tokenAccounting: false },
      }),
    ),
  ).toBe(false);
});

it('rejects compatible-family routes without a native source token counter', () => {
  expect(sourceChatModelAllowed(model('xai'))).toBe(false);
  expect(sourceChatModelAllowed(model('openrouter'))).toBe(false);
});

it.each(['grok', 'kimi'])(
  'rejects %s before source token counting or query execution',
  async (alias) => {
    const selected = resolveModelSelectionForWorkload(alias, 'chat');
    expect(selected.ok).toBe(true);
    if (!selected.ok) throw new Error('Configured model fixture missing');
    expect(selected.entry.modelRoute.id).toBe(
      alias === 'grok' ? 'xai' : 'openrouter',
    );
    const countTokens = vi.fn(async () => 1);
    const query = vi.fn(async () => '{}');
    await expect(
      prepareSourceSummary({
        appId: 'app' as never,
        answer: {
          id: 'answer',
          request: { model: alias },
          messages: [],
          selectedSourceIds: [],
        } as never,
        deadline: Date.now() + 10000,
        client: { isConfigured: () => true, countTokens, query },
        repository: {},
      }),
    ).rejects.toThrow('compatible configured chat model');
    expect(countTokens).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  },
);
