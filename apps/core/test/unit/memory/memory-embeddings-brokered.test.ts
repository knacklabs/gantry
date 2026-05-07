import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createExternalAgentCredentialInjection: vi.fn(() => ({
    env: {
      ANTHROPIC_BASE_URL: 'https://broker.local/anthropic',
      OPENAI_API_KEY: 'brokered-openai-key',
    },
    applied: true,
    brokerProfile: 'external',
  })),
  createAgentCredentialBroker: vi.fn(() => {
    throw new Error('onecli broker should not be used in external mode');
  }),
  resolveExternalCredentialBaseUrl: vi.fn(
    () => 'https://broker.local/anthropic',
  ),
}));

vi.mock('@core/config/index.js', () => ({
  DATA_DIR: '/tmp/myclaw-test',
  MEMORY_EMBED_BATCH_SIZE: 100,
  MEMORY_EMBED_MODEL: 'text-embedding-test',
  MEMORY_EMBED_PROVIDER: 'openai',
  getCredentialBrokerRuntimeConfig: () => ({
    mode: 'external',
    onecliUrl: '',
    externalBrokerBaseUrl: 'https://broker.local/anthropic',
  }),
}));

vi.mock('@core/config/credentials/broker-url-policy.js', () => ({
  resolveExternalCredentialBaseUrl: mocks.resolveExternalCredentialBaseUrl,
}));

vi.mock('@core/adapters/llm/external-credential-injection.js', () => ({
  createExternalAgentCredentialInjection:
    mocks.createExternalAgentCredentialInjection,
}));

vi.mock(
  '@core/adapters/credentials/agent-credential-broker-factory.js',
  () => ({
    createAgentCredentialBroker: mocks.createAgentCredentialBroker,
  }),
);

import { createEmbeddingProvider } from '@core/memory/memory-embeddings.js';

describe('brokered memory embedding provider factory', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    mocks.createExternalAgentCredentialInjection.mockClear();
    mocks.createAgentCredentialBroker.mockClear();
    mocks.resolveExternalCredentialBaseUrl.mockClear();
  });

  it('uses brokered OpenAI model credentials without reading process env keys', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ embedding: [0.1, 0.2, 0.3] }] }),
    } as Response);

    const provider = createEmbeddingProvider('openai');

    await expect(provider.embedMany(['hello'])).resolves.toEqual([
      [0.1, 0.2, 0.3],
    ]);
    expect(mocks.resolveExternalCredentialBaseUrl).toHaveBeenCalledWith(
      'https://broker.local/anthropic',
    );
    expect(mocks.createExternalAgentCredentialInjection).toHaveBeenCalledWith({
      normalizedBaseUrl: 'https://broker.local/anthropic',
    });
    expect(mocks.createAgentCredentialBroker).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.openai.com/v1/embeddings',
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer brokered-openai-key',
          'Content-Type': 'application/json',
        },
      }),
    );
  });
});
