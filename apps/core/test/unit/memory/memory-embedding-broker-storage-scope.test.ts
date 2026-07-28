import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => {
  const publishA = vi.fn(async () => undefined);
  const publishB = vi.fn(async () => undefined);
  const storageA = {
    repositories: { modelCredentials: { scope: 'a' } },
    runtimeEvents: { publish: publishA },
  };
  const storageB = {
    repositories: { modelCredentials: { scope: 'b' } },
    runtimeEvents: { publish: publishB },
  };
  return {
    currentStorage: storageA,
    publishA,
    publishB,
    storageA,
    storageB,
  };
});
const brokerA = vi.hoisted(() => ({
  close: vi.fn(async () => undefined),
  revokeInjection: vi.fn(async () => undefined),
}));
const brokerB = vi.hoisted(() => ({
  close: vi.fn(async () => undefined),
  revokeInjection: vi.fn(async () => undefined),
}));
const createAgentCredentialBroker = vi.hoisted(() => vi.fn());
const getAgentCredentialInjection = vi.hoisted(() => vi.fn());
const loggerWarn = vi.hoisted(() => vi.fn());

vi.mock('@core/config/index.js', () => ({
  getCredentialBrokerRuntimeConfig: () => ({
    mode: 'gantry',
    gatewayBindHost: '127.0.0.1',
  }),
}));

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getRuntimeStorage: () => state.currentStorage,
}));

vi.mock(
  '@core/adapters/credentials/agent-credential-broker-factory.js',
  () => ({ createAgentCredentialBroker }),
);

vi.mock('@core/application/credentials/agent-credential-service.js', () => ({
  getAgentCredentialInjection,
}));

vi.mock('@core/infrastructure/logging/logger.js', () => ({
  logger: { warn: loggerWarn },
}));

beforeEach(() => {
  state.currentStorage = state.storageA;
  createAgentCredentialBroker.mockImplementation(async (input) =>
    input.modelCredentials === state.storageA.repositories.modelCredentials
      ? brokerA
      : brokerB,
  );
  getAgentCredentialInjection.mockResolvedValue({
    env: {
      OPENAI_BASE_URL: 'http://127.0.0.1:49231/openai',
      OPENAI_API_KEY: 'gtw_memory_openai',
    },
    applied: true,
    brokerProfile: 'gantry',
  });
});

afterEach(() => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe('memory embedding broker storage scope', () => {
  it('replaces the broker when command-owned storage changes at the same gateway address', async () => {
    const { createEmbeddingProvider } =
      await import('@core/memory/memory-embeddings.js');
    const options = {
      model: 'text-embedding-3-small',
      dimensions: 1536,
      appId: 'default' as never,
    };

    await createEmbeddingProvider('openai', options).validateReady?.();
    const firstFactoryInput = createAgentCredentialBroker.mock.calls[0]?.[0];

    state.currentStorage = state.storageB;
    await firstFactoryInput.publishRuntimeEvent({ type: 'test' });
    await createEmbeddingProvider('openai', options).validateReady?.();

    expect(state.publishA).toHaveBeenCalledWith({ type: 'test' });
    expect(state.publishB).not.toHaveBeenCalled();
    expect(createAgentCredentialBroker).toHaveBeenCalledTimes(2);
    expect(createAgentCredentialBroker.mock.calls[1]?.[0]).toMatchObject({
      modelCredentials: state.storageB.repositories.modelCredentials,
    });
    expect(brokerA.close).toHaveBeenCalledOnce();
    expect(getAgentCredentialInjection).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ broker: brokerB }),
    );
  });

  it('reuses one broker while the storage runtime remains unchanged', async () => {
    const { createEmbeddingProvider } =
      await import('@core/memory/memory-embeddings.js');
    const options = {
      model: 'text-embedding-3-small',
      dimensions: 1536,
      appId: 'default' as never,
    };

    await createEmbeddingProvider('openai', options).validateReady?.();
    await createEmbeddingProvider('openai', options).validateReady?.();

    expect(createAgentCredentialBroker).toHaveBeenCalledOnce();
    expect(brokerA.close).not.toHaveBeenCalled();
  });

  it('continues replacement when the stale broker fails to close', async () => {
    const { createEmbeddingProvider } =
      await import('@core/memory/memory-embeddings.js');
    const options = {
      model: 'text-embedding-3-small',
      dimensions: 1536,
      appId: 'default' as never,
    };
    const closeError = new Error('stale broker close failed');

    await createEmbeddingProvider('openai', options).validateReady?.();
    brokerA.close.mockRejectedValueOnce(closeError);
    state.currentStorage = state.storageB;

    await expect(
      createEmbeddingProvider('openai', options).validateReady?.(),
    ).resolves.toBeUndefined();

    expect(createAgentCredentialBroker).toHaveBeenCalledTimes(2);
    expect(getAgentCredentialInjection).toHaveBeenLastCalledWith(
      expect.objectContaining({ broker: brokerB }),
    );
    expect(loggerWarn).toHaveBeenCalledWith(
      { err: closeError },
      'Failed to close replaced embedding credential broker',
    );
  });
});
