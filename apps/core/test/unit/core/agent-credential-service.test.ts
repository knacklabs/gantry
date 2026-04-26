import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentCredentialBroker } from '@core/domain/ports/agent-credential-broker.js';
import { CredentialBrokerPolicyError } from '@core/domain/models/credential-errors.js';

function makeBroker(
  overrides: {
    getInjection?: AgentCredentialBroker['getInjection'];
  } = {},
): AgentCredentialBroker {
  return {
    getInjection:
      overrides.getInjection ||
      (async () => ({
        env: {
          ANTHROPIC_BASE_URL: 'https://broker.example.com',
        },
        applied: true,
        brokerProfile: 'onecli',
      })),
    healthCheck: async () => ({
      status: 'pass',
      message: 'ok',
    }),
    getCapabilities: () => ({
      profile: 'onecli',
      supportsAgentBinding: true,
      returnsRawSecrets: false,
    }),
  };
}

async function loadCredentialService() {
  vi.resetModules();
  return import('@core/application/credentials/agent-credential-service.js');
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('agent credential service', () => {
  it('requires a broker only when broker mode is enabled', async () => {
    const { getAgentCredentialInjection } = await loadCredentialService();

    await expect(
      getAgentCredentialInjection({
        mode: 'onecli',
      } as never),
    ).rejects.toThrow('no agent credential broker was provided');

    await expect(
      getAgentCredentialInjection({
        mode: 'none',
      }),
    ).resolves.toEqual({
      env: {},
      applied: false,
      brokerProfile: 'none',
    });

    await expect(
      getAgentCredentialInjection({
        mode: 'external',
      } as never),
    ).rejects.toThrow('no external credential injection was provided');
  });

  it('passes safe external broker env to spawned agents', async () => {
    const { createExternalAgentCredentialInjection } =
      await import('@core/adapters/llm/external-credential-injection.js');
    const { getAgentCredentialInjection } = await loadCredentialService();

    await expect(
      getAgentCredentialInjection({
        mode: 'external',
        externalInjection: createExternalAgentCredentialInjection({
          normalizedBaseUrl: 'https://broker.example.com',
        }),
      }),
    ).resolves.toEqual({
      env: {
        ANTHROPIC_BASE_URL: 'https://broker.example.com',
      },
      applied: true,
      brokerProfile: 'external',
    });
  });

  it('preserves safe host env and drops raw agent credentials for external broker env', async () => {
    const { createExternalAgentCredentialInjection } =
      await import('@core/adapters/llm/external-credential-injection.js');

    expect(
      createExternalAgentCredentialInjection({
        normalizedBaseUrl: 'https://broker.example.com',
        hostCredentialEnv: {
          HTTPS_PROXY: 'http://proxy.example.com',
          ANTHROPIC_API_KEY: 'raw-secret',
          OPENAI_API_KEY: 'raw-secret',
        },
      }),
    ).toEqual({
      env: {
        ANTHROPIC_BASE_URL: 'https://broker.example.com',
        HTTPS_PROXY: 'http://proxy.example.com',
      },
      applied: true,
      brokerProfile: 'external',
    });
  });

  it('uses externally prepared credential injection without reading adapter config', async () => {
    const { getAgentCredentialInjection } = await loadCredentialService();

    await expect(
      getAgentCredentialInjection({
        mode: 'external',
        externalInjection: {
          env: { PROVIDER_BASE_URL: 'https://broker.example.com' },
          applied: true,
          brokerProfile: 'external',
        },
      }),
    ).resolves.toEqual({
      env: { PROVIDER_BASE_URL: 'https://broker.example.com' },
      applied: true,
      brokerProfile: 'external',
    });
  });

  it('keeps broker requests agent-scoped and does not request runtime-owned secrets', async () => {
    const getInjection = vi.fn(async () => ({
      env: {
        ANTHROPIC_BASE_URL: 'https://broker.example.com',
      },
      applied: true,
      brokerProfile: 'onecli' as const,
    }));
    const broker = makeBroker({ getInjection });
    const { getAgentCredentialInjection } = await loadCredentialService();

    const result = await getAgentCredentialInjection({
      mode: 'onecli',
      agentIdentifier: 'memory',
      broker,
    });

    expect(result).toEqual({
      env: {
        ANTHROPIC_BASE_URL: 'https://broker.example.com',
      },
      applied: true,
      brokerProfile: 'onecli',
    });
    expect(getInjection).toHaveBeenCalledWith({
      binding: {
        profile: 'onecli',
        agentIdentifier: 'memory',
      },
    });
  });

  it('propagates forbidden raw-secret broker failures and wraps transport failures', async () => {
    const { getAgentCredentialInjection } = await loadCredentialService();

    const forbiddenBroker = makeBroker({
      getInjection: async () => {
        throw new CredentialBrokerPolicyError(
          'OneCLI returned forbidden raw credential env key: OPENAI_API_KEY',
        );
      },
    });
    await expect(
      getAgentCredentialInjection({
        mode: 'onecli',
        broker: forbiddenBroker,
      }),
    ).rejects.toThrow('forbidden raw credential env key: OPENAI_API_KEY');

    const forbiddenValueBroker = makeBroker({
      getInjection: async () => {
        throw new CredentialBrokerPolicyError(
          'OneCLI returned forbidden raw credential env value',
        );
      },
    });
    await expect(
      getAgentCredentialInjection({
        mode: 'onecli',
        broker: forbiddenValueBroker,
      }),
    ).rejects.toThrow('forbidden raw credential env value');

    const unreachableBroker = makeBroker({
      getInjection: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    await expect(
      getAgentCredentialInjection({
        mode: 'onecli',
        agentIdentifier: 'agent-one',
        broker: unreachableBroker,
      }),
    ).rejects.toThrow(
      'Credential broker mode is enabled but the credential broker is not reachable for agent agent-one.',
    );
  });

  it('does not fail-open when a generic broker error mentions policy text', async () => {
    const { getAgentCredentialInjection } = await loadCredentialService();
    const broker = makeBroker({
      getInjection: async () => {
        throw new Error('forbidden raw credential env key: OPENAI_API_KEY');
      },
    });

    await expect(
      getAgentCredentialInjection({
        mode: 'onecli',
        broker,
      }),
    ).rejects.toThrow(
      'Credential broker mode is enabled but the credential broker is not reachable.',
    );
  });
});
