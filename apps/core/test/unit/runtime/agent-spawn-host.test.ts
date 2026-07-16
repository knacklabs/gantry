import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentCredentialBroker } from '@core/domain/ports/agent-credential-broker.js';
import {
  getHostRuntimeCredentialEnv,
  withControls,
} from '@core/runtime/agent-spawn-host.js';
import { resolveEffectivePermissionMode } from '@core/shared/permission-mode.js';

vi.mock('@core/config/index.js', () => ({
  AGENT_TIMEOUT: 30_000,
  DATA_DIR: '/tmp/gantry-agent-spawn-host-test',
  IDLE_TIMEOUT: 30_000,
  getCredentialBrokerRuntimeConfig: () => ({
    mode: 'gantry',
    gatewayBindHost: '127.0.0.1',
  }),
  getEffectiveModelConfig: vi.fn(),
  getRuntimeSettingsForConfig: vi.fn(),
  getSelectedAgentHarness: vi.fn(),
}));

describe('getHostRuntimeCredentialEnv', () => {
  let broker: AgentCredentialBroker;

  beforeEach(() => {
    broker = {
      getInjection: vi.fn(async () => ({
        env: {
          [['ANTHROPIC', 'BASE_URL'].join('_')]:
            'http://127.0.0.1:10254/anthropic',
          [['ANTHROPIC', 'API_KEY'].join('_')]: 'gtw_test',
        },
        credentialProviders: { [['ANTHROPIC', 'API_KEY'].join('_')]: 'native' },
        applied: true,
        brokerProfile: 'gantry',
      })),
      revokeInjection: vi.fn(async () => undefined),
      healthCheck: vi.fn(async () => ({
        status: 'pass',
        message: 'ready',
      })),
      getCapabilities: vi.fn(() => ({
        profile: 'gantry',
        supportsAgentBinding: false,
        supportsModelRuntimeProfile: true,
        returnsRawSecrets: false,
      })),
    };
  });

  it('synthesizes a revocation scope for interactive runs without a run id', async () => {
    const result = await getHostRuntimeCredentialEnv('main_agent', broker, {
      runContext: {
        appId: 'default' as never,
        agentId: 'main_agent' as never,
        chatJid: 'telegram:group' as never,
      },
      modelRouteId: 'anthropic',
    });

    const issuedBinding = vi.mocked(broker.getInjection).mock.calls[0]?.[0]
      .binding;
    expect(issuedBinding).toMatchObject({
      profile: 'gantry',
      purpose: 'model_runtime',
      appId: 'default',
      agentId: 'main_agent',
      conversationId: 'telegram:group',
      modelRouteId: 'anthropic',
      runId: expect.stringMatching(/^credential-run:/),
    });

    await result.revoke?.();

    expect(broker.revokeInjection).toHaveBeenCalledWith({
      binding: expect.objectContaining({
        profile: 'gantry',
        purpose: 'model_runtime',
        appId: 'default',
        runId: issuedBinding?.runId,
      }),
    });
  });

  it('preserves an existing job run id for gateway token revocation', async () => {
    const result = await getHostRuntimeCredentialEnv('main_agent', broker, {
      runContext: {
        appId: 'default' as never,
        agentId: 'main_agent' as never,
        runId: 'run:job-1' as never,
        jobId: 'job-1' as never,
        chatJid: 'telegram:group' as never,
      },
      modelRouteId: 'anthropic',
    });

    await result.revoke?.();

    expect(broker.getInjection).toHaveBeenCalledWith({
      binding: expect.objectContaining({ runId: 'run:job-1' }),
    });
    expect(broker.revokeInjection).toHaveBeenCalledWith({
      binding: expect.objectContaining({ runId: 'run:job-1' }),
    });
  });
});

describe('withControls', () => {
  const input = {
    prompt: 'hello',
    workspaceFolder: 'main_agent',
    chatJid: 'conversation:test',
  };

  it('uses only settings-owned tool rules', () => {
    const configured = [
      { tool: 'Bash', action: 'block' as const, reason: 'configured' },
    ];
    expect(
      withControls(
        {
          ...input,
          toolRules: [{ tool: 'Read', action: 'block', reason: 'untrusted' }],
        },
        { toolRules: configured },
      ).toolRules,
    ).toEqual(configured);
  });

  it('strips incoming tool rules when settings have none', () => {
    const result = withControls(
      {
        ...input,
        toolRules: [{ tool: 'Read', action: 'block', reason: 'untrusted' }],
      },
      { toolRules: [] },
    );
    expect(result).not.toHaveProperty('toolRules');
  });

  it('uses the host-resolved permission mode instead of incoming input', () => {
    expect(
      withControls(
        { ...input, permissionMode: 'auto' },
        { permissionMode: 'ask' },
      ).permissionMode,
    ).toBe('ask');
  });
});

describe('resolveEffectivePermissionMode', () => {
  it.each([
    ['auto', 'ask', 'auto'],
    [undefined, 'auto', 'auto'],
    [undefined, undefined, 'ask'],
  ] as const)(
    'resolves conversation %s over agent %s to %s',
    (conversationMode, agentMode, expected) => {
      expect(resolveEffectivePermissionMode(conversationMode, agentMode)).toBe(
        expected,
      );
    },
  );
});
