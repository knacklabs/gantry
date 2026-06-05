import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentCredentialBroker } from '@core/domain/ports/agent-credential-broker.js';
import { CredentialBrokerPolicyError } from '@core/domain/models/credential-errors.js';

function makeBroker(
  overrides: {
    getInjection?: AgentCredentialBroker['getInjection'];
    healthCheck?: AgentCredentialBroker['healthCheck'];
  } = {},
): AgentCredentialBroker {
  return {
    getInjection:
      overrides.getInjection ||
      (async () => ({
        env: {
          ANTHROPIC_BASE_URL: 'http://127.0.0.1:49231/anthropic',
          ANTHROPIC_API_KEY: 'gtw_test',
        },
        applied: true,
        brokerProfile: 'gantry',
      })),
    healthCheck:
      overrides.healthCheck ||
      (async () => ({
        status: 'pass',
        message: 'ok',
      })),
    getCapabilities: () => ({
      profile: 'gantry',
      supportsAgentBinding: false,
      supportsModelRuntimeProfile: true,
      modelRuntimeProfileIdentifier: 'gantry-model-access',
      returnsRawSecrets: true,
      projectsProviderTokens: false,
      projectedSecretEnvKeys: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY'],
    }),
  };
}

async function loadCredentialService() {
  vi.resetModules();
  return import('@core/application/credentials/agent-credential-service.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('agent credential service', () => {
  it('requires a broker only when Gantry gateway mode is enabled', async () => {
    const { getAgentCredentialInjection } = await loadCredentialService();

    await expect(
      getAgentCredentialInjection({
        mode: 'gantry',
      } as never),
    ).rejects.toThrow('no model gateway broker was provided');

    await expect(
      getAgentCredentialInjection({
        mode: 'none',
      }),
    ).resolves.toEqual({
      env: {},
      applied: false,
      brokerProfile: 'none',
    });
  });

  it('requests model credentials through route-scoped gateway binding', async () => {
    const getInjection = vi.fn(async () => ({
      env: {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:49231/openrouter',
        ANTHROPIC_API_KEY: 'gtw_test',
        ANTHROPIC_AUTH_TOKEN: 'gtw_test',
      },
      applied: true,
      brokerProfile: 'gantry' as const,
    }));
    const broker = makeBroker({ getInjection });
    const { getAgentCredentialInjection } = await loadCredentialService();

    const result = await getAgentCredentialInjection({
      mode: 'gantry',
      appId: 'app_1' as never,
      modelRouteId: 'openrouter' as never,
      broker,
    });

    expect(result.brokerProfile).toBe('gantry');
    expect(getInjection).toHaveBeenCalledWith({
      binding: {
        profile: 'gantry',
        purpose: 'model_runtime',
        appId: 'app_1',
        modelRouteId: 'openrouter',
      },
    });
  });

  it('keeps tool capability requests agent-scoped when a broker needs them', async () => {
    const getInjection = vi.fn(async () => ({
      env: {},
      applied: true,
      brokerProfile: 'gantry' as const,
    }));
    const broker = makeBroker({ getInjection });
    const { getAgentCredentialInjection } = await loadCredentialService();

    await getAgentCredentialInjection({
      mode: 'gantry',
      purpose: 'tool_capability',
      agentIdentifier: 'agent-one',
      broker,
    });

    expect(getInjection).toHaveBeenCalledWith({
      binding: {
        profile: 'gantry',
        purpose: 'tool_capability',
        agentIdentifier: 'agent-one',
      },
    });
  });

  it('propagates boundary failures and wraps gateway outages', async () => {
    const { getAgentCredentialInjection } = await loadCredentialService();
    const boundaryBroker = makeBroker({
      getInjection: async () => {
        throw new CredentialBrokerPolicyError('forbidden raw credential');
      },
    });

    await expect(
      getAgentCredentialInjection({
        mode: 'gantry',
        broker: boundaryBroker,
      }),
    ).rejects.toThrow('forbidden raw credential');

    const unreachableBroker = makeBroker({
      getInjection: async () => {
        throw new Error('connect ECONNREFUSED');
      },
      healthCheck: async () => ({
        status: 'fail',
        message:
          'Gantry Model Gateway is missing an active anthropic credential.',
        nextAction: 'Run `gantry credentials model set anthropic`.',
      }),
    });

    await expect(
      getAgentCredentialInjection({
        mode: 'gantry',
        agentIdentifier: 'agent-one',
        broker: unreachableBroker,
      }),
    ).rejects.toThrow(
      'Run `gantry credentials model status` and add the missing provider key',
    );
  });

  it('does not create credential broker profiles during setup', async () => {
    const { ensureAgentCredentialBinding, ensureModelCredentialBinding } =
      await loadCredentialService();

    await expect(
      ensureModelCredentialBinding({
        mode: 'gantry',
        broker: makeBroker(),
      }),
    ).resolves.toBeUndefined();
    await expect(
      ensureAgentCredentialBinding({
        mode: 'gantry',
        broker: makeBroker(),
        name: 'Default Agent',
        identifier: 'agent:main_agent',
      }),
    ).resolves.toBeUndefined();
  });
});
