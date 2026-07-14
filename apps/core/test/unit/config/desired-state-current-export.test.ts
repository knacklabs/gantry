import { describe, expect, it, vi } from 'vitest';

import { exportCurrentDesiredState } from '@core/config/settings/desired-state-current-export.js';
import {
  createDefaultRuntimeSettings,
  parseRuntimeSettings,
} from '@core/config/settings/runtime-settings.js';
import { renderRuntimeSettingsYaml } from '@core/config/settings/runtime-settings-renderer.js';

describe('exportCurrentDesiredState', () => {
  it('does not export internal app/control approval routes to settings', async () => {
    const settings = {
      providers: {},
      providerAccounts: {},
      conversations: {},
      bindings: {},
      agents: { main_agent: { runtime: 'worker' } },
    };
    const deps = {
      ops: { getAllConversationRoutes: vi.fn(async () => ({})) },
      repositories: {
        agents: {
          listAgents: vi.fn(async () => [
            {
              id: 'agent:main_agent',
              name: 'Main',
              status: 'active',
              createdAt: '2026-06-01T00:00:00.000Z',
              updatedAt: '2026-06-01T00:00:00.000Z',
            },
          ]),
        },
        tools: {
          listAgentToolBindingsForAgents: vi.fn(async () => []),
          listAgentToolSourcesForAgents: vi.fn(async () => []),
          listTools: vi.fn(async () => []),
        },
        skills: {
          listAgentSkillBindingsForAgents: vi.fn(async () => []),
          listSkills: vi.fn(async () => []),
        },
        mcpServers: { listAgentBindingsForAgents: vi.fn(async () => []) },
        providerAccounts: {
          listProviderAccounts: vi.fn(async () => [
            {
              id: 'control-default',
              agentId: 'main_agent',
              providerId: 'control-http',
              label: 'Control',
              status: 'active',
              config: {},
              runtimeSecretRefs: {},
            },
            {
              id: 'app-default',
              agentId: 'main_agent',
              providerId: 'app',
              label: 'App',
              status: 'active',
              config: {},
              runtimeSecretRefs: {},
            },
            {
              id: 'slack-default',
              agentId: 'main_agent',
              providerId: 'slack',
              label: 'Slack',
              status: 'active',
              config: {},
              runtimeSecretRefs: { bot_token: 'env:SLACK_BOT_TOKEN' },
            },
          ]),
          listConversationInstalls: vi.fn(async () => []),
        },
        conversations: {
          listConversations: vi.fn(async () => [
            {
              id: 'conversation:control',
              providerAccountId: 'control-default',
              externalRef: { value: 'control' },
              kind: 'channel',
              title: 'Control',
              status: 'active',
            },
            {
              id: 'conversation:slack',
              providerAccountId: 'slack-default',
              externalRef: { value: 'C123' },
              kind: 'channel',
              title: 'Engineering',
              status: 'active',
            },
          ]),
          listConversationApproversForConversations: vi.fn(async () => []),
        },
      },
    };

    const exported = await exportCurrentDesiredState({
      deps: deps as any,
      appId: 'app-one' as never,
      settings: settings as any,
    });

    expect(exported.providers).toEqual({
      slack: { enabled: true },
    });
    expect(exported.providerAccounts).toEqual({
      'slack-default': {
        agentId: 'main_agent',
        provider: 'slack',
        label: 'Slack',
        status: 'active',
        runtimeSecretRefs: { bot_token: 'env:SLACK_BOT_TOKEN' },
        externalIdentityRef: undefined,
        config: {},
      },
    });
    expect(Object.values(exported.conversations)).toEqual([
      expect.objectContaining({
        providerConnection: 'slack-default',
        providerAccount: 'slack-default',
        externalId: 'C123',
      }),
    ]);
    expect(exported.agents.main_agent?.runtime).toBeUndefined();
  });

  it('exports stored route bindings as conversation installed agents', async () => {
    const settings = parseRuntimeSettings(`agents:
  main_agent:
    name: Main
    runtime: inline
    model: gpt
    max_turns: 12
    max_run_tokens: 4096
    effort: high
    thinking: on
    max_output_tokens: 2048
`);
    settings.conversations = {
      shared_channel: {
        providerConnection: 'slack-default',
        providerAccount: 'slack-default',
        externalId: 'C123',
        kind: 'channel',
        displayName: 'Engineering',
        senderPolicy: { allow: '*', mode: 'trigger' },
        controlApprovers: [],
        installedAgents: {},
      },
    };
    const deps = {
      ops: { getAllConversationRoutes: vi.fn(async () => ({})) },
      repositories: {
        agents: {
          listAgents: vi.fn(async () => [
            {
              id: 'agent:main_agent',
              name: 'Main',
              status: 'active',
              createdAt: '2026-06-01T00:00:00.000Z',
              updatedAt: '2026-06-01T00:00:00.000Z',
            },
          ]),
        },
        tools: {
          listAgentToolBindingsForAgents: vi.fn(async () => []),
          listAgentToolSourcesForAgents: vi.fn(async () => []),
          listTools: vi.fn(async () => []),
        },
        skills: {
          listAgentSkillBindingsForAgents: vi.fn(async () => []),
          listSkills: vi.fn(async () => []),
        },
        mcpServers: { listAgentBindingsForAgents: vi.fn(async () => []) },
        providerAccounts: {
          listProviderAccounts: vi.fn(async () => [
            {
              id: 'slack-default',
              agentId: 'agent:main_agent',
              providerId: 'slack',
              label: 'Slack',
              status: 'active',
              config: {},
              runtimeSecretRefs: {},
            },
          ]),
          listConversationInstalls: vi.fn(async () => [
            {
              id: 'conversation-install:main_agent:conversation:slack',
              appId: 'app-one',
              agentId: 'agent:main_agent',
              providerAccountId: 'slack-default',
              conversationId: 'conversation:slack',
              displayName: 'Engineering',
              status: 'active',
              senderPolicy: 'provider_native',
              controlPolicy: 'conversation_approvers',
              memoryScope: 'app',
              memorySubject: {
                kind: 'conversation',
                appId: 'app-one',
                conversationId: 'conversation:slack',
                route: {
                  trigger: '@stored',
                  requiresTrigger: true,
                  agentConfig: { model: 'opus' },
                },
              },
              permissionPolicyIds: [],
              createdAt: '2026-06-01T00:00:00.000Z',
              updatedAt: '2026-06-01T00:00:00.000Z',
            },
            {
              id: 'conversation-install:main_agent:conversation:slack:thread',
              appId: 'app-one',
              agentId: 'agent:main_agent',
              providerAccountId: 'slack-default',
              conversationId: 'conversation:slack',
              threadId: 'thread:slack-default:C123:171.222',
              displayName: 'Engineering thread',
              status: 'active',
              senderPolicy: 'provider_native',
              controlPolicy: 'conversation_approvers',
              memoryScope: 'conversation',
              memorySubject: {
                kind: 'conversation',
                appId: 'app-one',
                conversationId: 'conversation:slack',
                route: {
                  trigger: '@thread',
                  requiresTrigger: true,
                },
              },
              permissionPolicyIds: [],
              createdAt: '2026-06-01T00:01:00.000Z',
              updatedAt: '2026-06-01T00:01:00.000Z',
            },
          ]),
        },
        conversations: {
          listConversations: vi.fn(async () => [
            {
              id: 'conversation:slack',
              providerAccountId: 'slack-default',
              externalRef: { value: 'C123' },
              kind: 'channel',
              title: 'Engineering',
              status: 'active',
            },
          ]),
          listThreads: vi.fn(async () => [
            {
              id: 'thread:slack-default:C123:171.222',
              appId: 'app-one',
              conversationId: 'conversation:slack',
              externalRef: {
                kind: 'conversation_thread',
                value: '171.222',
              },
              status: 'active',
              createdAt: '2026-06-01T00:01:00.000Z',
              updatedAt: '2026-06-01T00:01:00.000Z',
            },
          ]),
          listConversationApproversForConversations: vi.fn(async () => []),
        },
      },
    };

    const exported = await exportCurrentDesiredState({
      deps: deps as any,
      appId: 'app-one' as never,
      settings: settings as any,
    });

    expect(exported.conversations.shared_channel.installedAgents).toEqual({
      main_agent: {
        agentId: 'main_agent',
        providerAccountId: 'slack-default',
        threadId: undefined,
        status: 'active',
        addedAt: '2026-06-01T00:00:00.000Z',
        memoryScope: 'app',
        trigger: '@stored',
        requiresTrigger: true,
        model: 'opus',
      },
      'main_agent_171.222': {
        agentId: 'main_agent',
        providerAccountId: 'slack-default',
        threadId: '171.222',
        status: 'active',
        addedAt: '2026-06-01T00:01:00.000Z',
        memoryScope: 'conversation',
        trigger: '@thread',
        requiresTrigger: true,
        model: undefined,
      },
    });
    expect(exported.providerAccounts['slack-default']?.agentId).toBe(
      'main_agent',
    );
    expect(exported.agents.main_agent?.runtime).toBe('inline');
    expect(exported.agents.main_agent).toMatchObject({
      maxTurns: 12,
      maxRunTokens: 4096,
      effort: 'high',
      thinking: { mode: 'on' },
      maxOutputTokens: 2048,
    });
    const yaml = renderRuntimeSettingsYaml(exported as any);
    expect(yaml).toContain('installed_agents:');
    expect(yaml).toContain('      main_agent:');
    expect(yaml).toContain('      "main_agent_171.222":');
    expect(yaml).toContain('        agent: main_agent');
    expect(yaml).toContain('        thread_id: 171.222');
    expect(yaml).not.toContain('\nbindings:');
    const parsed = parseRuntimeSettings(yaml);
    expect(
      parsed.conversations.shared_channel.installedAgents['main_agent_171.222']
        ?.agentId,
    ).toBe('main_agent');
  });

  it('keeps disabled provider accounts needed by exported conversations', async () => {
    const settings = createDefaultRuntimeSettings();
    const deps = {
      ops: { getAllConversationRoutes: vi.fn(async () => ({})) },
      repositories: {
        agents: {
          listAgents: vi.fn(async () => [
            {
              id: 'agent:main_agent',
              name: 'Main',
              status: 'active',
              createdAt: '2026-06-01T00:00:00.000Z',
              updatedAt: '2026-06-01T00:00:00.000Z',
            },
          ]),
        },
        tools: {
          listAgentToolBindingsForAgents: vi.fn(async () => []),
          listAgentToolSourcesForAgents: vi.fn(async () => []),
          listTools: vi.fn(async () => []),
        },
        skills: {
          listAgentSkillBindingsForAgents: vi.fn(async () => []),
          listSkills: vi.fn(async () => []),
        },
        mcpServers: { listAgentBindingsForAgents: vi.fn(async () => []) },
        providerAccounts: {
          listProviderAccounts: vi.fn(async () => [
            {
              id: 'slack-disabled',
              agentId: 'agent:main_agent',
              providerId: 'slack',
              label: 'Disabled Slack',
              status: 'disabled',
              config: {},
              runtimeSecretRefs: {},
            },
          ]),
          listConversationInstalls: vi.fn(async () => []),
        },
        conversations: {
          listConversations: vi.fn(async () => [
            {
              id: 'conversation:slack-disabled',
              providerAccountId: 'slack-disabled',
              externalRef: { value: 'C999' },
              kind: 'channel',
              title: 'Disabled account channel',
              status: 'active',
            },
          ]),
          listConversationApproversForConversations: vi.fn(async () => []),
        },
      },
    };

    const exported = await exportCurrentDesiredState({
      deps: deps as any,
      appId: 'app-one' as never,
      settings,
    });

    expect(exported.providerAccounts['slack-disabled']?.status).toBe(
      'disabled',
    );
    expect(Object.values(exported.conversations)[0]?.providerAccount).toBe(
      'slack-disabled',
    );
    expect(exported.agents.main_agent?.runtime).toBeUndefined();
    expect(() =>
      parseRuntimeSettings(renderRuntimeSettingsYaml(exported)),
    ).not.toThrow();
  });

  it('exports live route bindings as conversation installed agents', async () => {
    const deps = {
      ops: {
        getAllConversationRoutes: vi.fn(async () => ({
          'sl:C999': {
            folder: 'main_agent',
            name: 'Main',
            trigger: '@main',
            added_at: '2026-06-02T00:00:00.000Z',
            requiresTrigger: true,
            agentConfig: { model: 'opus' },
          },
        })),
      },
      repositories: {
        agents: { listAgents: vi.fn(async () => []) },
        tools: {
          listAgentToolBindingsForAgents: vi.fn(async () => []),
          listAgentToolSourcesForAgents: vi.fn(async () => []),
          listTools: vi.fn(async () => []),
        },
        skills: {
          listAgentSkillBindingsForAgents: vi.fn(async () => []),
          listSkills: vi.fn(async () => []),
        },
        mcpServers: { listAgentBindingsForAgents: vi.fn(async () => []) },
        providerAccounts: {
          listProviderAccounts: vi.fn(async () => []),
          listConversationInstalls: vi.fn(async () => []),
        },
        conversations: {
          listConversations: vi.fn(async () => []),
          listConversationApproversForConversations: vi.fn(async () => []),
        },
      },
    };

    const settings = parseRuntimeSettings(`agents:
  main_agent:
    name: Main
    runtime: inline
    model: gpt
    max_turns: 9
    max_run_tokens: 2048
    effort: low
    thinking: off
    max_output_tokens: 1024
`);
    settings.providerAccounts.slack_custom = {
      agentId: 'main_agent',
      provider: 'slack',
      label: 'Custom Slack',
      runtimeSecretRefs: {},
    };
    settings.providerAccounts.slack_other = {
      agentId: 'main_agent',
      provider: 'slack',
      label: 'Other Slack',
      runtimeSecretRefs: {},
    };
    deps.ops.getAllConversationRoutes.mockResolvedValue({
      'sl:C999': {
        folder: 'main_agent',
        name: 'Main',
        providerAccountId: 'slack_other',
        trigger: '@main',
        added_at: '2026-06-02T00:00:00.000Z',
        requiresTrigger: true,
        agentConfig: { model: 'opus' },
      },
    });

    const exported = await exportCurrentDesiredState({
      deps: deps as any,
      appId: 'app-one' as never,
      settings,
    });
    const conversation = Object.values(exported.conversations)[0];

    expect(conversation.installedAgents.main_agent).toEqual({
      agentId: 'main_agent',
      providerAccountId: 'slack_other',
      status: 'active',
      addedAt: '2026-06-02T00:00:00.000Z',
      memoryScope: 'conversation',
      trigger: '@main',
      requiresTrigger: true,
      model: 'opus',
    });
    expect(exported.agents.main_agent?.runtime).toBe('inline');
    expect(exported.agents.main_agent).toMatchObject({
      maxTurns: 9,
      maxRunTokens: 2048,
      effort: 'low',
      thinking: { mode: 'off' },
      maxOutputTokens: 1024,
    });
  });

  it('keeps route-less channel installs trigger gated on export', async () => {
    const settings = createDefaultRuntimeSettings();
    const deps = {
      ops: { getAllConversationRoutes: vi.fn(async () => ({})) },
      repositories: {
        agents: {
          listAgents: vi.fn(async () => [
            {
              id: 'agent:main_agent',
              name: 'Main',
              status: 'active',
              createdAt: '2026-06-01T00:00:00.000Z',
              updatedAt: '2026-06-01T00:00:00.000Z',
            },
          ]),
        },
        tools: {
          listAgentToolBindingsForAgents: vi.fn(async () => []),
          listAgentToolSourcesForAgents: vi.fn(async () => []),
          listTools: vi.fn(async () => []),
        },
        skills: {
          listAgentSkillBindingsForAgents: vi.fn(async () => []),
          listSkills: vi.fn(async () => []),
        },
        mcpServers: { listAgentBindingsForAgents: vi.fn(async () => []) },
        providerAccounts: {
          listProviderAccounts: vi.fn(async () => [
            {
              id: 'slack_default',
              agentId: 'agent:main_agent',
              providerId: 'slack',
              label: 'Slack',
              status: 'active',
              config: {},
              runtimeSecretRefs: {},
            },
          ]),
          listConversationInstalls: vi.fn(async () => [
            {
              id: 'install:main_sales',
              appId: 'default',
              agentId: 'agent:main_agent',
              providerAccountId: 'slack_default',
              conversationId: 'conversation:slack_default:C123',
              displayName: 'Sales',
              status: 'active',
              memoryScope: 'conversation',
              memorySubject: { kind: 'conversation' },
              permissionPolicyIds: [],
              createdAt: '2026-06-02T00:00:00.000Z',
              updatedAt: '2026-06-02T00:00:00.000Z',
            },
          ]),
        },
        conversations: {
          listConversations: vi.fn(async () => [
            {
              id: 'conversation:slack_default:C123',
              providerAccountId: 'slack_default',
              externalRef: { value: 'C123' },
              kind: 'channel',
              title: 'Sales',
              status: 'active',
            },
          ]),
          listConversationApproversForConversations: vi.fn(async () => []),
        },
      },
    };

    const exported = await exportCurrentDesiredState({
      deps: deps as any,
      appId: 'default' as never,
      settings,
    });
    const conversation = Object.values(exported.conversations)[0];
    const binding = Object.values(exported.bindings)[0];

    expect(binding?.requiresTrigger).toBe(true);
    expect(binding?.trigger).toBe('');
    expect(conversation?.installedAgents.main_agent?.requiresTrigger).toBe(
      true,
    );
    expect(conversation?.installedAgents.main_agent?.trigger).toBe('');
    expect(renderRuntimeSettingsYaml(exported)).not.toContain('@agent');
  });
});
