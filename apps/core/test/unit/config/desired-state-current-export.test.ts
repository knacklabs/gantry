import { describe, expect, it, vi } from 'vitest';

import { exportCurrentDesiredState } from '@core/config/settings/desired-state-current-export.js';

describe('exportCurrentDesiredState', () => {
  it('does not export internal app/control approval routes to settings', async () => {
    const settings = {
      providers: {},
      providerConnections: {},
      conversations: {},
      bindings: {},
      agents: {},
    };
    const deps = {
      ops: { getAllConversationRoutes: vi.fn(async () => ({})) },
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
        providerConnections: {
          listProviderConnections: vi.fn(async () => [
            {
              id: 'control-default',
              providerId: 'control-http',
              label: 'Control',
              status: 'active',
              runtimeSecretRefs: [],
            },
            {
              id: 'app-default',
              providerId: 'app',
              label: 'App',
              status: 'active',
              runtimeSecretRefs: [],
            },
            {
              id: 'slack-default',
              providerId: 'slack',
              label: 'Slack',
              status: 'active',
              runtimeSecretRefs: ['SLACK_BOT_TOKEN'],
            },
          ]),
          listAgentConversationBindings: vi.fn(async () => []),
        },
        conversations: {
          listConversations: vi.fn(async () => [
            {
              id: 'conversation:control',
              providerConnectionId: 'control-default',
              externalRef: { value: 'control' },
              kind: 'channel',
              title: 'Control',
              status: 'active',
            },
            {
              id: 'conversation:slack',
              providerConnectionId: 'slack-default',
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
      slack: { enabled: true, defaultConnection: 'slack-default' },
    });
    expect(exported.providerConnections).toEqual({
      'slack-default': {
        provider: 'slack',
        label: 'Slack',
        runtimeSecretRefs: { bot_token: 'SLACK_BOT_TOKEN' },
      },
    });
    expect(Object.values(exported.conversations)).toEqual([
      expect.objectContaining({
        providerConnection: 'slack-default',
        externalId: 'C123',
      }),
    ]);
  });
});
