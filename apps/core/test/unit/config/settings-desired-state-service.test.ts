import { describe, expect, it, vi } from 'vitest';

import {
  classifySettingsChanges,
  SettingsDesiredStateService,
} from '@core/config/settings/desired-state-service.js';
import { createDefaultRuntimeSettings } from '@core/config/settings/runtime-settings.js';
import { ConversationAdministrationService } from '@core/application/provider-conversations/conversation-administration-service.js';

function makeRepositories(overrides: Record<string, unknown> = {}) {
  return {
    agents: {
      saveAgent: vi.fn(async () => undefined),
      listAgentDmAccess: vi.fn(async () => []),
      listAgentDmApprovers: vi.fn(async () => []),
      replaceAgentDmAccessPolicy: vi.fn(async () => undefined),
      replaceAgentCapabilityBindings: vi.fn(async () => undefined),
      listAgentPermissionRules: vi.fn(async () => []),
      replaceAgentPermissionRules: vi.fn(async () => []),
      disableAgent: vi.fn(async () => undefined),
      listAgents: vi.fn(async () => []),
    },
    tools: {
      getTool: vi.fn(async (id: string) =>
        id === 'tool:read'
          ? {
              id,
              appId: 'default',
              status: 'active',
              selectable: true,
            }
          : null,
      ),
      listAgentToolBindings: vi.fn(async () => []),
    },
    skills: {
      getSkill: vi.fn(async (id: string) =>
        id === 'skill:admin'
          ? {
              id,
              appId: 'default',
              status: 'approved',
              storage: { type: 'local' },
            }
          : null,
      ),
      listAgentSkillBindings: vi.fn(async () => []),
    },
    mcpServers: {
      getServer: vi.fn(async (id: string) =>
        id === 'mcp:github'
          ? {
              id,
              appId: 'default',
              status: 'approved',
              latestApprovedVersionId: 'mcp-version:github',
            }
          : null,
      ),
      listAgentBindings: vi.fn(async () => []),
    },
    providerConnections: {
      saveProviderConnection: vi.fn(async () => undefined),
    },
    ...overrides,
  } as any;
}

function makeOps(groups: Record<string, any> = {}) {
  return {
    getAllRegisteredGroups: vi.fn(async () => groups),
    setRegisteredGroup: vi.fn(async () => undefined),
    deleteRegisteredGroup: vi.fn(async () => undefined),
  };
}

describe('SettingsDesiredStateService', () => {
  it('validates capability references before reconciliation', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      dmAccess: [],
      capabilities: {
        toolIds: ['tool:read', 'tool:missing'],
        skillIds: ['skill:admin'],
        mcpServerIds: ['mcp:github'],
      },
    };
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories: makeRepositories(),
    });

    await expect(
      service.validateCapabilityReferences(settings),
    ).resolves.toEqual([
      'agents.main_agent.capabilities.tool_ids contains unavailable tool: tool:missing',
    ]);
  });

  it('reconciles desired agents without deleting DB-only bindings in phase 1', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.desiredState.authoritative = false;
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {
        primary: {
          jid: 'tg:100',
          trigger: '@main',
          addedAt: '2026-05-02T00:00:00.000Z',
          requiresTrigger: true,
          isMain: true,
        },
      },
      dmAccess: [],
      capabilities: {
        toolIds: [],
        skillIds: [],
        mcpServerIds: [],
      },
    };
    const ops = makeOps({
      'tg:old': {
        name: 'Old',
        folder: 'old',
        trigger: '@old',
        added_at: '2026-05-01T00:00:00.000Z',
      },
    });
    const repositories = makeRepositories();
    const service = new SettingsDesiredStateService({ ops, repositories });

    const result = await service.reconcile(settings);

    expect(result.invalidReferences).toEqual([]);
    expect(ops.setRegisteredGroup).toHaveBeenCalledWith(
      'tg:100',
      expect.objectContaining({ folder: 'main_agent', trigger: '@main' }),
    );
    expect(ops.deleteRegisteredGroup).not.toHaveBeenCalled();
  });

  it('removes absent DB bindings only in authoritative mode', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.desiredState.authoritative = true;
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      dmAccess: [],
      capabilities: {
        toolIds: [],
        skillIds: [],
        mcpServerIds: [],
      },
    };
    const ops = makeOps({
      'tg:old': {
        name: 'Old',
        folder: 'old',
        trigger: '@old',
        added_at: '2026-05-01T00:00:00.000Z',
      },
    });
    const service = new SettingsDesiredStateService({
      ops,
      repositories: makeRepositories(),
    });

    await service.reconcile(settings);

    expect(ops.deleteRegisteredGroup).toHaveBeenCalledWith('tg:old');
  });

  it('clears empty capability selections in authoritative mode', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.desiredState.authoritative = true;
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      dmAccess: [],
      capabilities: {
        toolIds: [],
        skillIds: [],
        mcpServerIds: [],
      },
    };
    const repositories = makeRepositories();
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories,
    });

    await service.reconcile(settings);

    expect(
      repositories.agents.replaceAgentCapabilityBindings,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent:main_agent',
        toolBindings: [],
        skillBindings: [],
        mcpBindings: [],
      }),
    );
  });

  it('creates desired conversations before applying approvers without duplicating them', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.providers.telegram.enabled = true;
    settings.providers.telegram.defaultConnection = 'telegram_default';
    settings.providerConnections.telegram_default = {
      provider: 'telegram',
      label: 'Telegram Default',
      runtimeSecretRefs: { bot_token: 'TELEGRAM_BOT_TOKEN' },
    };
    settings.conversations.kai = {
      providerConnection: 'telegram_default',
      externalId: '-100123',
      kind: 'channel',
      displayName: 'Kai',
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: ['5759865942'],
    };
    const savedConversations: any[] = [];
    const savedApprovers = new Map<string, string[]>();
    const providerConnection = {
      id: 'telegram_default',
      appId: 'default',
      providerId: 'telegram',
      label: 'Telegram Default',
      status: 'active',
      config: {},
      runtimeSecretRefs: ['TELEGRAM_BOT_TOKEN'],
      createdAt: '2026-05-02T00:00:00.000Z',
      updatedAt: '2026-05-02T00:00:00.000Z',
    };
    const conversations = {
      getConversation: vi.fn(
        async (id: string) =>
          savedConversations.find((conversation) => conversation.id === id) ??
          null,
      ),
      findConversationByExternalValue: vi.fn(
        async (input: any) =>
          savedConversations.find(
            (conversation) =>
              conversation.externalRef.value === input.externalConversationId,
          ) ?? null,
      ),
      saveConversation: vi.fn(async (conversation: any) => {
        savedConversations.push(conversation);
      }),
      listConversationApprovers: vi.fn(async (conversationId: string) =>
        (savedApprovers.get(conversationId) ?? []).map((externalUserId) => ({
          id: `approver:${externalUserId}`,
          appId: 'default',
          conversationId,
          externalUserId,
          createdAt: '2026-05-02T00:00:00.000Z',
          updatedAt: '2026-05-02T00:00:00.000Z',
        })),
      ),
      replaceConversationApprovers: vi.fn(async (input: any) => {
        savedApprovers.set(input.conversationId, input.externalUserIds);
        return input.externalUserIds.map((externalUserId: string) => ({
          id: `approver:${externalUserId}`,
          appId: input.appId,
          conversationId: input.conversationId,
          externalUserId,
          createdAt: input.updatedAt,
          updatedAt: input.updatedAt,
        }));
      }),
      listParticipantExternalUserIds: vi.fn(async () => []),
    };
    const repositories = makeRepositories({
      conversations,
      providerConnections: {
        getProviderConnection: vi.fn(async (id: string) =>
          id === 'telegram_default' ? providerConnection : null,
        ),
        saveProviderConnection: vi.fn(async () => undefined),
      },
    });
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories,
      clock: { now: () => '2026-05-02T00:00:00.000Z' },
    });

    const result = await service.reconcile(settings);

    expect(result.skipped).not.toContain(
      'conversation_approvers:kai:not-found',
    );
    expect(
      repositories.providerConnections.saveProviderConnection,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'telegram_default',
        providerId: 'telegram',
        runtimeSecretRefs: ['TELEGRAM_BOT_TOKEN'],
      }),
    );
    expect(conversations.saveConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'conversation:tg:-100123',
        providerConnectionId: 'telegram_default',
        externalRef: { kind: 'conversation', value: '-100123' },
        kind: 'group',
      }),
    );
    expect(conversations.replaceConversationApprovers).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation:tg:-100123',
        externalUserIds: ['5759865942'],
      }),
    );

    await service.reconcile(settings);

    expect(conversations.saveConversation).toHaveBeenCalledTimes(1);
    expect(conversations.replaceConversationApprovers).toHaveBeenCalledTimes(2);

    const administration = new ConversationAdministrationService(
      repositories as never,
      {
        validateControlApprovers: vi.fn(async (input) => ({
          validUserIds: input.userIds,
          invalidUserIds: [],
        })),
      },
    );
    await expect(
      administration.isControlApproverAllowed({
        appId: 'default' as never,
        providerId: 'telegram' as never,
        conversationJid: 'telegram:-100123',
        userId: '5759865942',
      }),
    ).resolves.toBe(true);
  });

  it('exports colliding conversation bindings without overwriting one another', async () => {
    const settings = createDefaultRuntimeSettings();
    const service = new SettingsDesiredStateService({
      ops: makeOps({
        'tg abc': {
          name: 'A',
          folder: 'main_agent',
          trigger: '@a',
          added_at: '2026-05-01T00:00:00.000Z',
        },
        'tg/abc': {
          name: 'B',
          folder: 'main_agent',
          trigger: '@b',
          added_at: '2026-05-01T00:00:00.000Z',
        },
      }),
      repositories: makeRepositories(),
    });

    const exported = await service.exportCurrent(settings);
    const bindingJids = Object.values(exported.agents.main_agent.bindings).map(
      (binding) => binding.jid,
    );

    expect(bindingJids.sort()).toEqual(['tg abc', 'tg/abc']);
    expect(Object.keys(exported.agents.main_agent.bindings)).toHaveLength(2);
  });

  it('disables DB-only agents and clears their policies in authoritative mode', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.desiredState.authoritative = true;
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      dmAccess: [],
      capabilities: {
        toolIds: [],
        skillIds: [],
        mcpServerIds: [],
      },
    };
    const repositories = makeRepositories({
      agents: {
        saveAgent: vi.fn(async () => undefined),
        listAgents: vi.fn(async () => [
          {
            id: 'agent:old_agent',
            appId: 'default',
            name: 'Old',
            status: 'active',
            createdAt: '2026-05-01T00:00:00.000Z',
            updatedAt: '2026-05-01T00:00:00.000Z',
          },
        ]),
        listAgentDmAccess: vi.fn(async () => []),
        listAgentDmApprovers: vi.fn(async () => []),
        replaceAgentDmAccessPolicy: vi.fn(async () => undefined),
        replaceAgentCapabilityBindings: vi.fn(async () => undefined),
        replaceAgentPermissionRules: vi.fn(async () => []),
        disableAgent: vi.fn(async () => undefined),
      },
    });
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories,
    });

    await service.reconcile(settings);

    expect(repositories.agents.disableAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent:old_agent' }),
    );
    expect(repositories.agents.replaceAgentDmAccessPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent:old_agent',
        accessEntries: [],
        approverEntries: [],
      }),
    );
  });

  it('classifies topology changes as restart-required', () => {
    const before = createDefaultRuntimeSettings();
    const after = createDefaultRuntimeSettings();
    after.agent.defaultModel = 'sonnet';
    after.providers.telegram.enabled = !before.providers.telegram.enabled;

    expect(classifySettingsChanges(before, after)).toEqual({
      liveApplied: ['agent_defaults'],
      restartRequired: ['providers'],
    });
  });

  it('classifies agent capability and memory changes as restart-required', () => {
    const before = createDefaultRuntimeSettings();
    const after = createDefaultRuntimeSettings();
    after.memory.enabled = false;
    after.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      dmAccess: [],
      capabilities: {
        toolIds: ['tool:read'],
        skillIds: [],
        mcpServerIds: [],
      },
    };

    expect(classifySettingsChanges(before, after)).toEqual({
      liveApplied: [],
      restartRequired: ['agents', 'memory'],
    });
  });
});
