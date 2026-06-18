import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The OpenAI-lane memory broker must be built with the SAME per-provider
// rate-cap limits getter the interactive broker uses, so memory extraction/
// dreaming/consolidation traffic honors limits.<provider>.requests_per_minute.
// Without it the broker admits unlimited memory traffic, bypassing the caps.

const brokerMock = vi.hoisted(() => ({
  getInjection: vi.fn(),
  revokeInjection: vi.fn(),
  healthCheck: vi.fn(),
  getCapabilities: vi.fn(),
}));
const createAgentCredentialBrokerMock = vi.hoisted(() => vi.fn());
const getAgentCredentialInjectionMock = vi.hoisted(() => vi.fn());

const memoryLimits = { providers: { groq: { requestsPerMinute: 11 } } };

vi.mock('@core/config/index.js', () => ({
  getCredentialBrokerRuntimeConfig: () => ({
    mode: 'gantry',
    gatewayBindHost: '127.0.0.1',
  }),
  getRuntimeSettingsForConfig: () => ({ limits: memoryLimits }),
}));

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getRuntimeStorage: () => ({
    repositories: { modelCredentials: {} },
    runtimeEvents: { publish: vi.fn(async () => undefined) },
  }),
}));

vi.mock(
  '@core/adapters/credentials/agent-credential-broker-factory.js',
  () => ({
    createAgentCredentialBroker: createAgentCredentialBrokerMock,
  }),
);

vi.mock('@core/application/credentials/agent-credential-service.js', () => ({
  getAgentCredentialInjection: getAgentCredentialInjectionMock,
}));

beforeEach(() => {
  createAgentCredentialBrokerMock.mockResolvedValue(brokerMock);
  brokerMock.revokeInjection.mockResolvedValue(undefined);
  getAgentCredentialInjectionMock.mockResolvedValue({
    env: {
      OPENAI_BASE_URL: 'http://127.0.0.1:49231/groq',
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

describe('OpenAI memory gateway injection', () => {
  it('builds the memory broker with a per-provider rate-cap limits getter', async () => {
    const { resolveGatewayMemoryInjection } =
      await import('@core/adapters/llm/openai-memory/memory-gateway-injection.js');

    await resolveGatewayMemoryInjection({
      appId: 'default' as never,
      modelRouteId: 'groq',
      runId: 'memory-query:test' as never,
    });

    const factoryInput = createAgentCredentialBrokerMock.mock.calls[0]?.[0];
    expect(typeof factoryInput.limits).toBe('function');
    // The getter reads the live runtime limits so caps apply to memory traffic.
    expect(factoryInput.limits()).toEqual(memoryLimits);
  });
});
