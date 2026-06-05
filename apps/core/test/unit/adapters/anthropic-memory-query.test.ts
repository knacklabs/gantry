import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.hoisted(() => vi.fn());
const brokerMock = vi.hoisted(() => ({
  getInjection: vi.fn(),
  revokeInjection: vi.fn(),
  healthCheck: vi.fn(),
  getCapabilities: vi.fn(),
}));
const createAgentCredentialBrokerMock = vi.hoisted(() => vi.fn());

vi.mock('@core/config/index.js', () => ({
  getCredentialBrokerRuntimeConfig: () => ({
    mode: 'gantry',
    gatewayBindHost: '127.0.0.1',
  }),
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
});
