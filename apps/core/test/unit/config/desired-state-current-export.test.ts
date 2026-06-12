import { describe, expect, it, vi } from 'vitest';

import { exportCurrentDesiredState } from '@core/config/settings/desired-state-current-export.js';
import {
  DEEPAGENTS_ENGINE,
  DEFAULT_AGENT_ENGINE,
} from '@core/shared/agent-engine.js';

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

  it('preserves a per-agent engine override across projection round-trips', async () => {
    const settings = {
      agent: { defaultAgentEngine: DEFAULT_AGENT_ENGINE },
      providers: {},
      providerConnections: {},
      conversations: {},
      bindings: {},
      agents: {
        main_agent: {
          name: 'Main',
          folder: 'main_agent',
          agentEngine: DEEPAGENTS_ENGINE,
          bindings: {},
          sources: { skills: [], mcpServers: [], tools: [] },
          capabilities: [],
          accessPreset: 'full',
        },
      },
    };
    const deps = {
      ops: { getAllConversationRoutes: vi.fn(async () => ({})) },
      repositories: {
        agents: {
          listAgents: vi.fn(async () => [
            {
              id: 'agent:main_agent',
              appId: 'app-one',
              name: 'Main',
              status: 'active',
              createdAt: '2026-06-03T00:00:00.000Z',
              updatedAt: '2026-06-03T00:00:00.000Z',
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
        providerConnections: {
          listProviderConnections: vi.fn(async () => []),
          listAgentConversationBindings: vi.fn(async () => []),
        },
        conversations: {
          listConversations: vi.fn(async () => []),
          listConversationApproversForConversations: vi.fn(async () => []),
        },
      },
    };

    const exported = await exportCurrentDesiredState({
      deps: deps as any,
      appId: 'app-one' as never,
      settings: settings as any,
    });

    expect(exported.agents.main_agent.agentEngine).toBe(DEEPAGENTS_ENGINE);
  });

  function groupLoopDeps(routeEngine: typeof DEEPAGENTS_ENGINE) {
    return {
      ops: {
        getAllConversationRoutes: vi.fn(async () => ({
          'tg:group_main': {
            name: 'Main',
            folder: 'main_agent',
            trigger: '@bot',
            added_at: '2026-06-03T00:00:00.000Z',
            requiresTrigger: true,
            // The route carries the EFFECTIVE engine reconcile projected
            // (here equal to defaults.agent_engine), NOT an explicit override.
            agentConfig: { agentEngine: routeEngine },
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
        providerConnections: {
          listProviderConnections: vi.fn(async () => []),
          listAgentConversationBindings: vi.fn(async () => []),
        },
        conversations: {
          listConversations: vi.fn(async () => []),
          listConversationApproversForConversations: vi.fn(async () => []),
        },
      },
    };
  }

  it('A5: does not pin an agent that merely inherits defaults.agent_engine as an override', async () => {
    // defaults.agent_engine = deepagents; the route carries the effective
    // deepagents engine, but the agent has no explicit settings.yaml override.
    const settings = {
      agent: { defaultAgentEngine: DEEPAGENTS_ENGINE },
      providers: {},
      providerConnections: {},
      conversations: {},
      bindings: {},
      agents: {},
    };

    const exported = await exportCurrentDesiredState({
      deps: groupLoopDeps(DEEPAGENTS_ENGINE) as any,
      appId: 'app-one' as never,
      settings: settings as any,
    });

    // No explicit agent_engine override materialized; the default stays implicit.
    expect(exported.agents.main_agent.agentEngine).toBeUndefined();
  });

  it('A5: still exports an engine that differs from the (flipped) default as an override', async () => {
    // After flipping the default back to the system default, a route still
    // carrying deepagents is a genuine override and must be exported.
    const settings = {
      agent: { defaultAgentEngine: DEFAULT_AGENT_ENGINE },
      providers: {},
      providerConnections: {},
      conversations: {},
      bindings: {},
      agents: {},
    };

    const exported = await exportCurrentDesiredState({
      deps: groupLoopDeps(DEEPAGENTS_ENGINE) as any,
      appId: 'app-one' as never,
      settings: settings as any,
    });

    expect(exported.agents.main_agent.agentEngine).toBe(DEEPAGENTS_ENGINE);
  });
});
