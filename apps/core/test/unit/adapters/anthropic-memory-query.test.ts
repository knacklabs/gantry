import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.hoisted(() => vi.fn());
const systemPromptDynamicBoundary = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__';
const brokerMock = vi.hoisted(() => ({
  getInjection: vi.fn(),
  revokeInjection: vi.fn(),
  healthCheck: vi.fn(),
  getCapabilities: vi.fn(),
}));
const createAgentCredentialBrokerMock = vi.hoisted(() => vi.fn());

const memoryLimits = { providers: { anthropic: { requestsPerMinute: 7 } } };

vi.mock('@core/config/index.js', () => ({
  getCredentialBrokerRuntimeConfig: () => ({
    mode: 'gantry',
    gatewayBindHost: '127.0.0.1',
  }),
  getRuntimeSettingsForConfig: () => ({ limits: memoryLimits }),
}));

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getRuntimeStorage: () => ({
    repositories: {
      modelCredentials: {},
    },
    runtimeEvents: {
      publish: vi.fn(async () => undefined),
    },
  }),
}));

vi.mock(
  '@core/adapters/credentials/agent-credential-broker-factory.js',
  () => ({
    createAgentCredentialBroker: createAgentCredentialBrokerMock,
  }),
);

beforeEach(() => {
  vi.doMock(['@anthropic-ai', '/claude-agent-sdk'].join(''), () => ({
    query: queryMock,
    SYSTEM_PROMPT_DYNAMIC_BOUNDARY: systemPromptDynamicBoundary,
  }));
  createAgentCredentialBrokerMock.mockResolvedValue(brokerMock);
  brokerMock.getInjection.mockResolvedValue({
    env: {
      [['ANTHROPIC', 'BASE_URL'].join('_')]: 'http://127.0.0.1:49231/anthropic',
      [['ANTHROPIC', 'API_KEY'].join('_')]: 'gtw_memory',
    },
    credentialProviders: { [['ANTHROPIC', 'API_KEY'].join('_')]: 'native' },
    applied: true,
    brokerProfile: 'gantry',
  });
  brokerMock.revokeInjection.mockResolvedValue(undefined);
  brokerMock.healthCheck.mockResolvedValue({
    status: 'pass',
    message: 'ready',
  });
  brokerMock.getCapabilities.mockReturnValue({
    profile: 'gantry',
    supportsAgentBinding: false,
    supportsModelRuntimeProfile: true,
    modelRuntimeProfileIdentifier: 'gantry-model-access',
    returnsRawSecrets: true,
    projectsProviderTokens: false,
    projectedSecretEnvKeys: [
      ['ANTHROPIC', 'BASE_URL'].join('_'),
      ['ANTHROPIC', 'API_KEY'].join('_'),
    ],
  });
  queryMock.mockReturnValue(
    (async function* () {
      yield {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'memory result' }],
        },
      };
    })(),
  );
});

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

async function drainPrompt(prompt: unknown): Promise<unknown[]> {
  expect(typeof prompt).not.toBe('string');
  const messages: unknown[] = [];
  for await (const message of prompt as AsyncIterable<unknown>) {
    messages.push(message);
  }
  return messages;
}

describe('Anthropic memory query gateway credentials', () => {
  it('revokes the run-scoped gateway token after the query completes', async () => {
    const { runClaudeQuery } =
      await import('@core/adapters/llm/anthropic-claude-agent/memory-query.js');

    await expect(
      runClaudeQuery({
        appId: 'default' as never,
        model: 'claude-sonnet-4-6',
        prompt: 'Summarize memory.',
      }),
    ).resolves.toBe('memory result');

    const binding = brokerMock.getInjection.mock.calls[0]?.[0].binding;
    expect(binding).toMatchObject({
      profile: 'gantry',
      purpose: 'model_runtime',
      appId: 'default',
      modelRouteId: 'anthropic',
      runId: expect.stringMatching(/^memory-query:/),
    });
    expect(brokerMock.revokeInjection).toHaveBeenCalledWith({
      binding: expect.objectContaining({
        profile: 'gantry',
        purpose: 'model_runtime',
        appId: 'default',
        modelRouteId: 'anthropic',
        runId: binding.runId,
      }),
    });
  });

  it('builds the memory broker with a per-provider rate-cap limits getter', async () => {
    const { runClaudeQuery } =
      await import('@core/adapters/llm/anthropic-claude-agent/memory-query.js');

    await runClaudeQuery({
      appId: 'default' as never,
      model: 'claude-sonnet-4-6',
      prompt: 'Summarize memory.',
    });

    const factoryInput = createAgentCredentialBrokerMock.mock.calls[0]?.[0];
    expect(typeof factoryInput.limits).toBe('function');
    // The getter reads the live runtime limits so caps apply to memory traffic.
    expect(factoryInput.limits()).toEqual(memoryLimits);
  });

  it('passes cacheable memory blocks as Anthropic cached user content', async () => {
    const { runClaudeQuery } =
      await import('@core/adapters/llm/anthropic-claude-agent/memory-query.js');

    await runClaudeQuery({
      appId: 'default' as never,
      model: 'claude-sonnet-4-6',
      prompt: 'fallback prompt',
      systemPrompt: 'memory extraction system instructions',
      userBlocks: [
        { text: 'stable extraction examples', cacheStatic: true },
        { text: 'current conversation turn' },
      ],
    });

    const params = queryMock.mock.calls[0]?.[0];
    expect(params.options.systemPrompt).toEqual([
      'memory extraction system instructions',
      systemPromptDynamicBoundary,
    ]);

    const messages = await drainPrompt(params.prompt);
    expect(messages).toEqual([
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'stable extraction examples',
              cache_control: { type: 'ephemeral' },
            },
            { type: 'text', text: 'current conversation turn' },
          ],
        },
        parent_tool_use_id: null,
        session_id: '',
      },
    ]);
  });

  it('reports Anthropic SDK result usage through onUsage', async () => {
    queryMock.mockReturnValueOnce(
      (async function* () {
        yield {
          type: 'result',
          result: 'memory result',
          usage: {
            input_tokens: 120,
            output_tokens: 24,
            cache_read_input_tokens: 80,
            cache_creation_input_tokens: 16,
          },
        };
      })(),
    );

    const { runClaudeQuery } =
      await import('@core/adapters/llm/anthropic-claude-agent/memory-query.js');

    const usageSeen: unknown[] = [];
    await expect(
      runClaudeQuery({
        appId: 'default' as never,
        model: 'claude-sonnet-4-6',
        prompt: 'Summarize memory.',
        onUsage: (usage) => usageSeen.push(usage),
      }),
    ).resolves.toBe('memory result');

    expect(usageSeen).toEqual([
      {
        input_tokens: 120,
        output_tokens: 24,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 16,
      },
    ]);
  });
});
