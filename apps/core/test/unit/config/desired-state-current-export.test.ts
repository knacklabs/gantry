import { describe, expect, it, vi } from 'vitest';

import { exportCurrentDesiredState } from '@core/application/settings/desired-state-current-export.js';
import { createDefaultRuntimeSettings } from '@core/config/settings/runtime-settings.js';

function deps() {
  return {
    ops: { getAllConversationRoutes: vi.fn(async () => ({})) },
    repositories: {
      agents: {
        listAgents: vi.fn(async () => [
          {
            id: 'agent:main_agent',
            appId: 'default',
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
            appId: 'default',
            agentId: 'agent:main_agent',
            providerId: 'slack',
            label: 'Slack',
            status: 'active',
            config: {},
            runtimeSecretRefs: { bot_token: 'env:SLACK_BOT_TOKEN' },
            createdAt: '2026-06-01T00:00:00.000Z',
            updatedAt: '2026-06-01T00:00:00.000Z',
          },
        ]),
      },
    },
  };
}

describe('exportCurrentDesiredState', () => {
  it('preserves settings-owned conversation topology while refreshing projections', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.agents.main_agent = {
      name: 'Configured Main',
      folder: 'main_agent',
      delegates: [],
      sources: { skills: [], mcpServers: [], tools: [] },
      capabilities: [],
      accessPreset: 'full',
    };
    settings.conversations.shared_channel = {
      providerAccount: 'slack-default',
      externalId: 'C123',
      kind: 'channel',
      displayName: 'Engineering',
      brainHarvest: false,
      requiresTrigger: true,
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: ['U1'],
      installedAgents: {
        main_agent: {
          agentId: 'main_agent',
          providerAccountId: 'slack-default',
          status: 'active',
          addedAt: '2026-06-01T00:00:00.000Z',
          memoryScope: 'conversation',
        },
      },
    };

    const exported = await exportCurrentDesiredState({
      deps: deps() as never,
      appId: 'default' as never,
      settings,
    });

    expect(exported.conversations).toEqual(settings.conversations);
    expect(exported.agents.main_agent.name).toBe('Main');
    expect(exported.providerAccounts['slack-default']).toEqual(
      expect.objectContaining({
        provider: 'slack',
        agentId: 'main_agent',
        runtimeSecretRefs: { bot_token: 'env:SLACK_BOT_TOKEN' },
      }),
    );
  });

  it('does not reconstruct conversations from live routes', async () => {
    const settings = createDefaultRuntimeSettings();
    const input = deps();
    input.ops.getAllConversationRoutes.mockResolvedValue({
      'sl:C123': { folder: 'main_agent' },
    });

    const exported = await exportCurrentDesiredState({
      deps: input as never,
      appId: 'default' as never,
      settings,
    });

    expect(exported.conversations).toEqual({});
    expect(input.ops.getAllConversationRoutes).not.toHaveBeenCalled();
  });

  it('preserves internal provider accounts referenced by configured conversations', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.providers.app = { enabled: true };
    settings.providerAccounts.app_default = {
      agentId: 'main_agent',
      provider: 'app',
      label: 'App',
      runtimeSecretRefs: {},
    };
    settings.conversations.app_default = {
      providerAccount: 'app_default',
      externalId: 'default',
      kind: 'service',
      displayName: 'App',
      brainHarvest: false,
      requiresTrigger: false,
      senderPolicy: { allow: '*', mode: 'always' },
      controlApprovers: [],
      installedAgents: {},
    };
    const input = deps();
    input.repositories.providerAccounts.listProviderAccounts.mockResolvedValue([
      {
        id: 'app_default',
        appId: 'default',
        agentId: 'agent:main_agent',
        providerId: 'app',
        label: 'App',
        status: 'active',
        config: {},
        runtimeSecretRefs: {},
        createdAt: '2026-06-01T00:00:00.000Z',
        updatedAt: '2026-06-01T00:00:00.000Z',
      },
    ] as never);

    const exported = await exportCurrentDesiredState({
      deps: input as never,
      appId: 'default' as never,
      settings,
    });

    expect(exported.providerAccounts.app_default).toEqual(
      expect.objectContaining({ provider: 'app', agentId: 'main_agent' }),
    );
    expect(exported.providers.app).toEqual({ enabled: true });
    expect(exported.conversations.app_default.providerAccount).toBe(
      'app_default',
    );
  });

  it('retains referenced settings-owned provider accounts missing from projection rows', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.providers.slack = { enabled: true };
    settings.providerAccounts.slack_default = {
      agentId: 'main_agent',
      provider: 'slack',
      label: 'Slack',
      runtimeSecretRefs: { bot_token: 'env:SLACK_BOT_TOKEN' },
    };
    settings.conversations.shared_channel = {
      providerAccount: 'slack_default',
      externalId: 'slack:C123',
      kind: 'channel',
      displayName: 'Engineering',
      brainHarvest: false,
      requiresTrigger: true,
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: ['slack:UADMIN'],
      installedAgents: {},
    };
    const input = deps();
    input.repositories.providerAccounts.listProviderAccounts.mockResolvedValue(
      [],
    );

    const exported = await exportCurrentDesiredState({
      deps: input as never,
      appId: 'default' as never,
      settings,
    });

    expect(exported.providerAccounts.slack_default).toEqual(
      settings.providerAccounts.slack_default,
    );
    expect(exported.providers.slack).toEqual({ enabled: true });
  });

  it('filters current and legacy synthetic provider accounts', async () => {
    const settings = createDefaultRuntimeSettings();
    const input = deps();
    input.repositories.providerAccounts.listProviderAccounts.mockResolvedValue([
      {
        id: 'channel-providerAccount:slack:C123',
        appId: 'default',
        agentId: 'agent:main_agent',
        providerId: 'slack',
        label: 'Current synthetic',
        status: 'active',
        config: {},
        runtimeSecretRefs: {},
        createdAt: '2026-06-01T00:00:00.000Z',
        updatedAt: '2026-06-01T00:00:00.000Z',
      },
      {
        id: 'channel-providerConnection:slack:C456',
        appId: 'default',
        agentId: 'agent:main_agent',
        providerId: 'slack',
        label: 'Legacy synthetic',
        status: 'active',
        config: {},
        runtimeSecretRefs: {},
        createdAt: '2026-06-01T00:00:00.000Z',
        updatedAt: '2026-06-01T00:00:00.000Z',
      },
    ] as never);

    const exported = await exportCurrentDesiredState({
      deps: input as never,
      appId: 'default' as never,
      settings,
    });

    expect(exported.providerAccounts).toEqual({});
    expect(exported.providers).toEqual({});
  });
});
