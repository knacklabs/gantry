import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentCredentialBroker } from '@core/domain/ports/agent-credential-broker.js';
import { CredentialBrokerPolicyError } from '@core/domain/models/credential-errors.js';

function makeBroker(
  overrides: {
    getInjection?: AgentCredentialBroker['getInjection'];
    healthCheck?: AgentCredentialBroker['healthCheck'];
    ensureAgent?: (agent: {
      name: string;
      identifier: string;
    }) => Promise<{ created?: boolean }>;
  } = {},
): AgentCredentialBroker & {
  ensureAgent?: (agent: {
    name: string;
    identifier: string;
  }) => Promise<{ created?: boolean }>;
} {
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
      projectsProviderTokens: false,
    }),
    ...(overrides.healthCheck ? { healthCheck: overrides.healthCheck } : {}),
    ...(overrides.ensureAgent ? { ensureAgent: overrides.ensureAgent } : {}),
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

  it('fails closed for external broker env without copying caller env', async () => {
    const { createExternalAgentCredentialInjection } =
      await import('@core/adapters/llm/external-credential-injection.js');

    expect(
      createExternalAgentCredentialInjection({
        normalizedBaseUrl: 'https://broker.example.com',
      }),
    ).toEqual({
      env: {
        ANTHROPIC_BASE_URL: 'https://broker.example.com',
      },
      applied: true,
      brokerProfile: 'external',
    });
  });

  it('does not manufacture OpenRouter token provenance from external env', async () => {
    const { createExternalAgentCredentialInjection } =
      await import('@core/adapters/llm/external-credential-injection.js');

    expect(
      createExternalAgentCredentialInjection({
        normalizedBaseUrl: 'https://openrouter.ai/api',
      }),
    ).toEqual({
      env: {
        ANTHROPIC_BASE_URL: 'https://openrouter.ai/api',
      },
      applied: true,
      brokerProfile: 'external',
    });

    expect(
      createExternalAgentCredentialInjection({
        normalizedBaseUrl: 'https://broker.example.com',
      }),
    ).toEqual({
      env: {
        ANTHROPIC_BASE_URL: 'https://broker.example.com',
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

  it('requests brokered model credentials through the shared model runtime purpose', async () => {
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
        purpose: 'model_runtime',
      },
    });
  });

  it('keeps tool capability credential requests agent-scoped', async () => {
    const getInjection = vi.fn(async () => ({
      env: {
        ANTHROPIC_BASE_URL: 'https://broker.example.com',
      },
      applied: true,
      brokerProfile: 'onecli' as const,
    }));
    const broker = makeBroker({ getInjection });
    const { getAgentCredentialInjection } = await loadCredentialService();

    await getAgentCredentialInjection({
      mode: 'onecli',
      purpose: 'tool_capability',
      agentIdentifier: 'agent-one',
      broker,
    });

    expect(getInjection).toHaveBeenCalledWith({
      binding: {
        profile: 'onecli',
        purpose: 'tool_capability',
        agentIdentifier: 'agent-one',
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
      'Credential broker mode is enabled but the credential broker is not reachable for MyClaw Model Access. Reason: connect ECONNREFUSED.',
    );
  });

  it('includes broker health and recovery guidance for tool capability broker outages', async () => {
    const { getAgentCredentialInjection } = await loadCredentialService();
    const error = Object.assign(
      new Error('connect ECONNREFUSED 127.0.0.1:10254'),
      { code: 'ECONNREFUSED' },
    );
    const broker = makeBroker({
      getInjection: async () => {
        throw error;
      },
      healthCheck: async () => ({
        status: 'fail',
        message:
          'Could not reach OneCLI at http://localhost:10254: connect ECONNREFUSED 127.0.0.1:10254',
        nextAction:
          "Run `myclaw local doctor`. If you use MyClaw's provided local stack, start it from the directory containing the shipped stack file, or pass that stack file explicitly, then retry.",
      }),
    });

    await expect(
      getAgentCredentialInjection({
        mode: 'onecli',
        purpose: 'tool_capability',
        agentIdentifier: 'agent:main_agent',
        broker,
      }),
    ).rejects.toThrow(
      [
        'Credential broker mode is enabled but the credential broker is not reachable for agent agent:main_agent.',
        'Reason: ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:10254.',
        'Broker health: Could not reach OneCLI at http://localhost:10254: connect ECONNREFUSED 127.0.0.1:10254',
        "Next action: Run `myclaw local doctor`. If you use MyClaw's provided local stack, start it from the directory containing the shipped stack file, or pass that stack file explicitly, then retry.",
        "Recovery: Run `myclaw doctor` and `myclaw local doctor`. If you use MyClaw's provided local stack, start or recover OneCLI from the directory containing its shipped stack file, or pass that stack file explicitly.",
      ].join(' '),
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
      'Credential broker mode is enabled but the credential broker is not reachable for MyClaw Model Access. Reason: forbidden raw credential env key: OPENAI_API_KEY.',
    );
  });

  it('ensures only the shared Model Access profile for onecli model credentials', async () => {
    const ensureAgent = vi.fn(async () => ({ created: true }));
    const broker = makeBroker({ ensureAgent });
    const { ensureModelCredentialBinding } = await loadCredentialService();

    await expect(
      ensureModelCredentialBinding({
        mode: 'onecli',
        broker,
      }),
    ).resolves.toEqual({ created: true });

    expect(ensureAgent).toHaveBeenCalledWith({
      name: 'MyClaw Model Access',
      identifier: 'myclaw-model-access',
    });
  });

  it('ensures agent-scoped credential profiles for tool capabilities', async () => {
    const ensureAgent = vi.fn(async () => ({ created: false }));
    const broker = makeBroker({ ensureAgent });
    const { ensureAgentCredentialBinding } = await loadCredentialService();

    await expect(
      ensureAgentCredentialBinding({
        mode: 'onecli',
        broker,
        name: 'Main Agent',
        identifier: 'agent:main_agent',
      }),
    ).resolves.toEqual({ created: false });

    expect(ensureAgent).toHaveBeenCalledWith({
      name: 'Main Agent',
      identifier: 'agent:main_agent',
    });
  });
});
