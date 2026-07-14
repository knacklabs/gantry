import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentCredentialBroker } from '@core/domain/ports/agent-credential-broker.js';

const anthropicProvider = () => 'anthropic';
const claudeCodeOAuthTokenKey = () =>
  ['CLAUDE', 'CODE', 'OAUTH', 'TOKEN'].join('_');

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

async function loadPreflight(broker: AgentCredentialBroker | undefined) {
  vi.doMock('@core/adapters/storage/postgres/runtime-store.js', () => ({
    getRuntimeStorage: () => ({
      repositories: {
        modelCredentials: {},
      },
    }),
  }));
  vi.doMock(
    '@core/adapters/credentials/agent-credential-broker-factory.js',
    () => ({
      createAgentCredentialBroker: vi.fn(async () => broker),
    }),
  );
  return import('@core/adapters/llm/model-provider-preflight.js');
}

function gatewayBroker(env: Record<string, string>): AgentCredentialBroker {
  return {
    getInjection: vi.fn(async () => ({
      env,
      credentialProviders: { ANTHROPIC_API_KEY: 'native' },
      applied: true,
      brokerProfile: 'gantry',
    })),
    revokeInjection: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    healthCheck: vi.fn(async () => ({
      status: 'pass',
      message: 'ready',
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

describe('model provider preflight', () => {
  it('fails Anthropic preflight without Gantry Model Gateway', async () => {
    const { preflightModelProvider } = await loadPreflight(undefined);

    await expect(
      preflightModelProvider({
        runtimeHome: '/tmp/gantry-model-preflight-test',
        providerId: anthropicProvider(),
        settings: {
          credentialBroker: {
            mode: 'none',
          },
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 'fail',
      message: 'Anthropic requires Gantry Model Gateway credentials.',
    });
  });

  it('passes when the gateway projects only loopback auth', async () => {
    const broker = gatewayBroker({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:49231/anthropic',
      ANTHROPIC_API_KEY: 'gtw_test',
    });
    const { preflightModelProvider } = await loadPreflight(broker);

    await expect(
      preflightModelProvider({
        runtimeHome: '/tmp/gantry-model-preflight-test',
        providerId: anthropicProvider(),
        settings: {
          credentialBroker: {
            mode: 'gantry',
          },
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: 'pass',
    });
    expect(broker.revokeInjection).toHaveBeenCalledWith({
      binding: expect.objectContaining({
        profile: 'gantry',
        purpose: 'model_runtime',
        modelRouteId: 'anthropic',
        runId: expect.stringMatching(/^model-preflight:/),
        // CLI callers omit appId; the broker requires one, so the preflight
        // must default to the single-app scope.
        appId: 'default',
      }),
    });
    expect(broker.close).toHaveBeenCalledOnce();
  });

  it('fails if gateway projection contains a raw provider key', async () => {
    const { preflightModelProvider } = await loadPreflight(
      gatewayBroker({
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:49231/anthropic',
        ANTHROPIC_API_KEY: 'sk-ant-raw',
      }),
    );

    await expect(
      preflightModelProvider({
        runtimeHome: '/tmp/gantry-model-preflight-test',
        providerId: anthropicProvider(),
        settings: {
          credentialBroker: {
            mode: 'gantry',
          },
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 'fail',
    });
  });

  it('fails when Gantry projects a raw Claude Code OAuth token for Anthropic', async () => {
    const broker = gatewayBroker({
      [claudeCodeOAuthTokenKey()]: 'sk-ant-oat-test',
    });
    const { preflightModelProvider } = await loadPreflight(broker);

    await expect(
      preflightModelProvider({
        runtimeHome: '/tmp/gantry-model-preflight-test',
        providerId: anthropicProvider(),
        settings: {
          credentialBroker: {
            mode: 'gantry',
          },
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      status: 'fail',
    });
  });
});
