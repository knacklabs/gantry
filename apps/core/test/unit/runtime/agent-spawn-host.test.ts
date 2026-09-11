import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentCredentialBroker } from '@core/domain/ports/agent-credential-broker.js';
import {
  getHostRuntimeCredentialEnv,
  prepareInlineAgentHostContext,
  withControls,
} from '@core/runtime/agent-spawn-host.js';
import { resolveEffectivePermissionMode } from '@core/shared/permission-mode.js';
import {
  DEEPAGENTS_ENGINE,
  DEFAULT_AGENT_ENGINE,
} from '@core/shared/agent-engine.js';

const hostSpies = vi.hoisted(() => ({
  engine: 'anthropic_sdk' as 'anthropic_sdk' | 'deepagents',
  publishRuntimeEvent: vi.fn(),
}));

vi.mock('@core/config/index.js', () => ({
  AGENT_TIMEOUT: 30_000,
  DATA_DIR: '/tmp/gantry-agent-spawn-host-test',
  IDLE_TIMEOUT: 30_000,
  getCredentialBrokerRuntimeConfig: () => ({
    mode: 'gantry',
    gatewayBindHost: '127.0.0.1',
  }),
  getEffectiveModelConfig: vi.fn(() => ({})),
  getRuntimeSettingsForConfig: vi.fn(() => ({
    agents: {},
    modelFamilies: [],
    runtime: { sandbox: { provider: 'direct' } },
  })),
  getSelectedAgentHarness: vi.fn(() => 'auto'),
}));

vi.mock('@core/runtime/agent-spawn-model-resolution.js', () => ({
  resolveSpawnModel: vi.fn(async () => ({
    resolvedModel: {
      ok: true,
      value: {
        agentEngine: hostSpies.engine,
        runnerModel: 'test-model',
        modelEntry: {
          displayName: 'Test model',
          modelRoute: { label: 'Test provider' },
        },
      },
    },
  })),
}));

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getConfiguredModelProvidersForApp: vi.fn(async () => []),
  getRuntimeFileArtifactStore: vi.fn(() => undefined),
  getRuntimeEventExchange: vi.fn(() => ({
    publish: hostSpies.publishRuntimeEvent,
  })),
  getRuntimeStorage: vi.fn(() => ({
    repositories: {
      agents: { getAgent: vi.fn(async () => undefined) },
      agentConfigs: { getConfigVersion: vi.fn(async () => undefined) },
    },
  })),
}));

describe('getHostRuntimeCredentialEnv', () => {
  let broker: AgentCredentialBroker;

  beforeEach(() => {
    hostSpies.engine = DEFAULT_AGENT_ENGINE;
    hostSpies.publishRuntimeEvent.mockReset();
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

describe('prepareInlineAgentHostContext', () => {
  const group = {
    name: 'Team',
    folder: 'team',
    trigger: '',
    added_at: '2026-01-01T00:00:00.000Z',
    conversationKind: 'dm' as const,
  };
  const input = {
    prompt: 'hello',
    workspaceFolder: 'team',
    chatJid: 'tg:1001',
    appId: 'app-one',
    agentId: 'agent-one',
  };

  beforeEach(() => {
    hostSpies.engine = DEFAULT_AGENT_ENGINE;
    hostSpies.publishRuntimeEvent.mockReset();
  });

  it('the resolved engine from the inline host path selects the Anthropic tool name', async () => {
    const context = await prepareInlineAgentHostContext(group, {
      ...input,
      capabilityCatalog: {
        schemaVersion: 1,
        digest: 'catalog:inline',
        readyActions: [
          {
            kind: 'reviewed_capability',
            stableRef: 'sheets.read',
            displayName: 'Read sheets',
            description: 'Read reviewed ranges.',
            category: 'Sheets',
            invocations: [
              {
                kind: 'local_cli',
                toolRef: 'capability_run',
                capabilityId: 'sheets.read',
                argumentPatterns: ['["sheets","get","*"]'],
              },
            ],
          },
        ],
        installedSkills: [],
        connectedMcpSources: [],
      },
    });

    expect(context.compiledSystemPrompt).toContain(
      'mcp__gantry__capability_run',
    );
  });

  it('hard overflow aborts the inline host spawn and publishes the same diagnostic', async () => {
    hostSpies.engine = DEFAULT_AGENT_ENGINE;
    const readyActions = Array.from({ length: 600 }, (_, index) => ({
      kind: 'reviewed_capability' as const,
      stableRef: `capability.${index}.${'x'.repeat(60)}`,
      displayName: `Capability ${index}`,
      description: 'Ready.',
      category: 'Operations',
    }));

    await expect(
      prepareInlineAgentHostContext(group, {
        ...input,
        runId: 'run-one',
        jobId: 'job-one',
        capabilityCatalog: {
          schemaVersion: 1,
          digest: 'catalog:overflow',
          readyActions,
          installedSkills: [],
          connectedMcpSources: [],
        },
      }),
    ).rejects.toThrow('Capability catalog overflow');

    expect(hostSpies.publishRuntimeEvent).toHaveBeenCalledOnce();
    expect(hostSpies.publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          diagnostic: 'capability_catalog_overflow',
          grantedCount: 600,
          sheddingStage: 'compact_overflow',
        }),
      }),
    );
    expect(
      JSON.stringify(hostSpies.publishRuntimeEvent.mock.calls),
    ).not.toContain('capability.0');
  });

  it('leaves inline DeepAgents capability guidance without a mapped dispatcher name', async () => {
    hostSpies.engine = DEEPAGENTS_ENGINE;
    const context = await prepareInlineAgentHostContext(group, input);

    expect(context.compiledSystemPrompt).not.toContain(
      'mcp__gantry__capability_run',
    );
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
