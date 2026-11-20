import { afterEach, expect, it, vi } from 'vitest';
import {
  configureCustomModelCatalogEntries,
  resolveModelSelectionForWorkload,
} from '../../../src/shared/model-catalog.js';
import {
  createSourceModelSnapshot,
  requireSourceModelSnapshot,
  sourceModelProfile,
} from '../../../src/shared/source-model-snapshot.js';
import { resolveSpawnModel } from '../../../src/runtime/agent-spawn-model-resolution.js';
import { resolveInitialGroupExecutionProviderId } from '../../../src/runtime/group-initial-execution-provider.js';
import { prepareSourceSummary } from '../../../src/runtime/source-discussion-summary.js';
import { validateSourceLearningProposal } from '../../../src/memory/source-learning-validation.js';
import { countAnthropicSourceTokens } from '../../../src/adapters/llm/anthropic-claude-agent/source-token-count.js';
import { countOpenAiSourceTokens } from '../../../src/adapters/llm/openai-memory/source-token-count.js';
import { createRouteAwareMemoryLlmClient } from '../../../src/adapters/llm/route-aware-memory-llm-client.js';
const gateway = vi.hoisted(() => ({
  resolve: vi.fn(),
  revoke: vi.fn(async () => {}),
}));
vi.mock(
  '../../../src/adapters/llm/openai-memory/memory-gateway-injection.js',
  () => ({ resolveGatewayMemoryInjection: gateway.resolve }),
);
afterEach(() => {
  configureCustomModelCatalogEntries([]);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each(['haiku', 'gpt-5.5'])(
  'keeps admitted %s for answer, summary, count and learning after alias replacement/removal',
  async (before) => {
    const a = resolveModelSelectionForWorkload(before, 'chat');
    const b = resolveModelSelectionForWorkload(
      before === 'haiku' ? 'gpt-5.5' : 'haiku',
      'chat',
    );
    if (!a.ok || !b.ok) throw new Error('Fixture missing');
    const alias = 'snapshot-replay';
    const old = {
      ...a.entry,
      id: 'snapshot-old',
      aliases: [alias],
      recommendedAlias: alias,
      runnerModel: `frozen-${before}`,
    };
    configureCustomModelCatalogEntries([old]);
    const selected = resolveModelSelectionForWorkload(alias, 'chat');
    if (!selected.ok) throw new Error('Admission fixture missing');
    // Exercise the exact private JSON serialization used by pending interactions.
    const pin = JSON.parse(
      JSON.stringify(createSourceModelSnapshot(alias, selected.entry)),
    );
    configureCustomModelCatalogEntries([
      {
        ...b.entry,
        id: 'snapshot-new',
        aliases: [alias],
        recommendedAlias: alias,
      },
    ]);
    expect(resolveModelSelectionForWorkload(alias, 'chat')).toMatchObject({
      ok: true,
      entry: { runnerModel: b.entry.runnerModel },
    });
    configureCustomModelCatalogEntries([]);
    expect(resolveModelSelectionForWorkload(alias, 'chat').ok).toBe(false);
    const providers = vi.fn(async () => new Set(['openai', 'anthropic']));
    const input = {
      group: { folder: 'snapshot' },
      appId: 'app',
      agentHarness: 'auto' as const,
      modelConfig: { model: alias, source: 'source' },
      listConfiguredProviders: providers,
      agentInput: { model: alias, sourceModelSnapshot: pin } as never,
    };
    const spawned = await resolveSpawnModel(input);
    expect(spawned.resolvedModel).toMatchObject({
      ok: true,
      value: {
        runnerModel: old.runnerModel,
        modelRoute: { id: old.modelRoute.id },
      },
    });
    const initial = await resolveInitialGroupExecutionProviderId({
      group: input.group,
      appId: 'app',
      defaultModel: alias,
      pinnedModel: pin.entry,
      agentHarness: 'auto',
      listConfiguredProviders: providers,
    });
    expect(initial.initialModelSelection.model?.runnerModel).toBe(
      old.runnerModel,
    );
    expect(initial.failoverCandidates).toEqual([]);
    expect(providers).not.toHaveBeenCalled();

    const count = vi.fn(async () => 10);
    const summarize = vi.fn(async () =>
      JSON.stringify({ summary: 'A supported instruction.' }),
    );
    const wrongLane = {
      isConfigured: () => true,
      countTokens: vi.fn(async () => {
        throw new Error('Changed provider used');
      }),
      query: vi.fn(async () => {
        throw new Error('Changed provider used');
      }),
    };
    const lane = {
      isConfigured: () => true,
      countTokens: count,
      query: summarize,
    };
    const client = createRouteAwareMemoryLlmClient({
      anthropic: before === 'haiku' ? lane : wrongLane,
      openai: before === 'haiku' ? wrongLane : lane,
    });
    await prepareSourceSummary({
      appId: 'app' as never,
      answer: {
        id: 'answer',
        request: { model: alias } as never,
        modelSnapshot: pin,
        messages: [],
        selectedSourceIds: ['M1'],
        summaryWork: {
          id: 'digest',
          messages: [{ content: 'Keep answers clear' }],
          sourceIds: ['M1'],
        } as never,
      },
      deadline: Date.now() + 10000,
      client,
      repository: { saveSourceSummary: async (value) => value.text },
    });
    expect(count.mock.calls[0][0]).toMatchObject({
      model: old.runnerModel,
      modelProfile: { modelRoute: old.modelRoute.id },
    });
    expect(summarize.mock.calls[0][0]).toMatchObject({
      model: old.runnerModel,
      modelProfile: { modelRoute: old.modelRoute.id },
    });

    gateway.resolve.mockResolvedValue({
      injection: {
        env: {
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:3939/anthropic',
          ANTHROPIC_AUTH_TOKEN: 'gtw_test',
          ANTHROPIC_API_KEY: 'gtw_test',
          OPENAI_BASE_URL: 'http://127.0.0.1:3939/openai',
          OPENAI_API_KEY: 'gtw_test',
        },
      },
      revoke: gateway.revoke,
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ input_tokens: 42 }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const countOperation =
      before === 'haiku' ? countAnthropicSourceTokens : countOpenAiSourceTokens;
    expect(
      await countOperation({
        appId: 'app' as never,
        model: old.runnerModel,
        modelProfile: sourceModelProfile(pin),
        prompt: 'Exact source',
      }),
    ).toBe(42);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe(
      old.runnerModel,
    );
    expect(gateway.resolve).toHaveBeenLastCalledWith(
      expect.objectContaining({
        appId: 'app',
        modelRouteId: old.modelRoute.id,
      }),
    );

    const validate = vi.fn(async () =>
      JSON.stringify({
        decision: 'allow',
        reusable: true,
        tenderFact: false,
        sensitiveProfile: false,
        scopeAppropriate: true,
        grounding: 'explicit_instruction',
        confidence: 0.99,
        supportingSourceIds: ['M1'],
        reason: 'Human style instruction',
      }),
    );
    const learning = await validateSourceLearningProposal({
      candidateId: 'candidate',
      context: {
        answerId: 'answer',
        sessionId: 'session',
        claimToken: 'claim',
        request: { model: alias, questionSourceId: 'M1' },
        modelSnapshot: pin,
        scope: { appId: 'app', personId: 'person', workspaceId: 'W1' },
        subject: { subjectType: 'group' },
        deadlineAtMs: Date.now() + 10000,
      } as never,
      evidence: [
        {
          sourceMessageId: 'M1',
          authorId: 'person',
          text: 'Please keep answers clear.',
          createdAt: '2026-11-20',
          revisionId: 'R1',
        },
      ],
      proposal: {
        kind: 'preference',
        key: 'style',
        value: 'Keep answers clear',
        source: 'discussion-explicit',
        supportingSourceIds: ['M1'],
      },
      client: { isConfigured: () => true, query: validate },
    });
    expect(learning.allowed).toBe(true);
    expect(validate.mock.calls[0][0]).toMatchObject({
      model: old.runnerModel,
      modelProfile: { modelRoute: old.modelRoute.id },
    });
  },
);
it('requires a new attempt for accepted legacy requests without a private snapshot', () => {
  expect(() => requireSourceModelSnapshot(undefined)).toThrow(
    'start a new attempt',
  );
});
