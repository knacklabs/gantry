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

  it('removes hidden opaque skill bindings in authoritative mode', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.desiredState.authoritative = true;
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      dmAccess: [],
      capabilities: {
        toolIds: [],
        skillIds: ['skill:admin'],
        mcpServerIds: [],
      },
    };
    const repositories = makeRepositories();
    repositories.skills.listAgentSkillBindings = vi.fn(async () => [
      {
        id: 'agent-skill-binding:agent:main_agent:skill:3014949c-a616-4b2c-80e7-0bc61bb31e85',
        appId: 'default',
        agentId: 'agent:main_agent',
        skillId: 'skill:3014949c-a616-4b2c-80e7-0bc61bb31e85',
        status: 'active',
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-01T00:00:00.000Z',
      },
    ]);
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories,
    });

    await service.reconcile(settings);

    expect(
      repositories.agents.replaceAgentCapabilityBindings,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        skillBindings: [expect.objectContaining({ skillId: 'skill:admin' })],
      }),
    );
  });

  it('preserves hidden opaque skill bindings only for non-authoritative visible settings', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.desiredState.authoritative = false;
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {},
      dmAccess: [],
      capabilities: {
        toolIds: [],
        skillIds: ['skill:admin'],
        mcpServerIds: [],
      },
    };
    const repositories = makeRepositories();
    repositories.skills.listAgentSkillBindings = vi.fn(async () => [
      {
        id: 'agent-skill-binding:agent:main_agent:skill:3014949c-a616-4b2c-80e7-0bc61bb31e85',
        appId: 'default',
        agentId: 'agent:main_agent',
        skillId: 'skill:3014949c-a616-4b2c-80e7-0bc61bb31e85',
        status: 'active',
        createdAt: '2026-05-01T00:00:00.000Z',
        updatedAt: '2026-05-01T00:00:00.000Z',
      },
    ]);
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories,
    });

    await service.reconcile(settings);

    expect(
      repositories.agents.replaceAgentCapabilityBindings,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        skillBindings: expect.arrayContaining([
          expect.objectContaining({ skillId: 'skill:admin' }),
          expect.objectContaining({
            skillId: 'skill:3014949c-a616-4b2c-80e7-0bc61bb31e85',
          }),
        ]),
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
      kind: 'group',
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
      getConversationByExternalRef: vi.fn(
        async (input: any) =>
          savedConversations.find(
            (conversation) =>
              conversation.providerConnectionId ===
                input.providerConnectionId &&
              conversation.externalRef.value === input.externalConversationId,
          ) ?? null,
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

  it('reconciles one agent with provider-scoped DM admins and conversation approvers', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.providers.slack.enabled = true;
    settings.providers.slack.defaultConnection = 'slack_default';
    settings.providers.teams.enabled = true;
    settings.providers.teams.defaultConnection = 'teams_default';
    settings.providerConnections.slack_default = {
      provider: 'slack',
      label: 'Slack Default',
      runtimeSecretRefs: { bot_token: 'SLACK_BOT_TOKEN' },
    };
    settings.providerConnections.teams_default = {
      provider: 'teams',
      label: 'Teams Default',
      runtimeSecretRefs: { client_id: 'TEAMS_CLIENT_ID' },
    };
    settings.agents.main_agent = {
      name: 'Main',
      folder: 'main_agent',
      bindings: {
        slack_sales: {
          jid: 'slack:C123',
          name: 'Sales Slack',
          trigger: '@main',
          addedAt: '2026-05-02T00:00:00.000Z',
          requiresTrigger: true,
          isMain: true,
        },
        teams_sales: {
          jid: 'teams:19:channel@thread.tacv2',
          name: 'Sales Teams',
          trigger: '@main',
          addedAt: '2026-05-02T00:00:00.000Z',
          requiresTrigger: true,
          isMain: false,
        },
      },
      dmAccess: [
        { provider: 'slack', userIds: ['U123'], adminUserId: 'U123' },
        {
          provider: 'teams',
          userIds: ['8:orgid:abc'],
          adminUserId: '8:orgid:abc',
        },
      ],
      capabilities: { toolIds: [], skillIds: [], mcpServerIds: [] },
    };
    settings.conversations.sales_slack = {
      providerConnection: 'slack_default',
      externalId: 'C123',
      kind: 'channel',
      displayName: 'Sales Slack',
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: ['U123'],
    };
    settings.conversations.sales_teams = {
      providerConnection: 'teams_default',
      externalId: '19:channel@thread.tacv2',
      kind: 'channel',
      displayName: 'Sales Teams',
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: ['8:orgid:abc'],
    };
    const savedConversations: any[] = [];
    const savedApprovers = new Map<string, string[]>();
    const conversations = {
      getConversation: vi.fn(
        async (id: string) =>
          savedConversations.find((conversation) => conversation.id === id) ??
          null,
      ),
      getConversationByExternalRef: vi.fn(
        async (input: any) =>
          savedConversations.find(
            (conversation) =>
              conversation.providerConnectionId ===
                input.providerConnectionId &&
              conversation.externalRef.value === input.externalConversationId,
          ) ?? null,
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
      replaceConversationApprovers: vi.fn(async (input: any) => {
        savedApprovers.set(input.conversationId, input.externalUserIds);
        return input.externalUserIds.map((externalUserId: string) => ({
          id: `approver:${input.conversationId}:${externalUserId}`,
          appId: input.appId,
          conversationId: input.conversationId,
          externalUserId,
          createdAt: input.updatedAt,
          updatedAt: input.updatedAt,
        }));
      }),
    };
    const repositories = makeRepositories({
      conversations,
      providerConnections: {
        saveProviderConnection: vi.fn(async () => undefined),
      },
    });
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories,
      clock: { now: () => '2026-05-02T00:00:00.000Z' },
    });

    const result = await service.reconcile(settings);

    expect(result.applied).toEqual(
      expect.arrayContaining([
        'dm_access:main_agent',
        'conversation_approvers:sales_slack',
        'conversation_approvers:sales_teams',
      ]),
    );
    expect(repositories.agents.replaceAgentDmAccessPolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        accessEntries: [
          { providerId: 'slack', externalUserId: 'U123' },
          { providerId: 'teams', externalUserId: '8:orgid:abc' },
        ],
        approverEntries: [
          { providerId: 'slack', externalUserId: 'U123' },
          { providerId: 'teams', externalUserId: '8:orgid:abc' },
        ],
      }),
    );
    expect(savedApprovers).toEqual(
      new Map([
        ['conversation:sl:C123', ['U123']],
        ['conversation:teams:19:channel@thread.tacv2', ['8:orgid:abc']],
      ]),
    );
  });

  it('does not rewrite another provider conversation when external IDs collide', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.providers.telegram.enabled = true;
    settings.providers.telegram.defaultConnection = 'telegram_default';
    settings.providers.slack.enabled = true;
    settings.providers.slack.defaultConnection = 'slack_default';
    settings.providerConnections.telegram_default = {
      provider: 'telegram',
      label: 'Telegram Default',
      runtimeSecretRefs: { bot_token: 'TELEGRAM_BOT_TOKEN' },
    };
    settings.providerConnections.slack_default = {
      provider: 'slack',
      label: 'Slack Default',
      runtimeSecretRefs: { bot_token: 'SLACK_BOT_TOKEN' },
    };
    settings.conversations.telegram_conflict = {
      providerConnection: 'telegram_default',
      externalId: 'C123',
      kind: 'group',
      displayName: 'Telegram C123',
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: ['5759865942'],
    };
    const slackConversation = {
      id: 'conversation:sl:C123',
      appId: 'default',
      providerConnectionId: 'slack_default',
      externalRef: { kind: 'conversation', value: 'C123' },
      kind: 'channel',
      title: 'Slack C123',
      status: 'active',
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
    };
    const savedConversations: any[] = [slackConversation];
    const conversations = {
      getConversation: vi.fn(
        async (id: string) =>
          savedConversations.find((conversation) => conversation.id === id) ??
          null,
      ),
      getConversationByExternalRef: vi.fn(
        async (input: any) =>
          savedConversations.find(
            (conversation) =>
              conversation.providerConnectionId ===
                input.providerConnectionId &&
              conversation.externalRef.value === input.externalConversationId,
          ) ?? null,
      ),
      findConversationByExternalValue: vi.fn(async () => slackConversation),
      saveConversation: vi.fn(async (conversation: any) => {
        savedConversations.push(conversation);
      }),
      replaceConversationApprovers: vi.fn(async (input: any) =>
        input.externalUserIds.map((externalUserId: string) => ({
          conversationId: input.conversationId,
          externalUserId,
          createdAt: input.updatedAt,
          updatedAt: input.updatedAt,
        })),
      ),
    };
    const service = new SettingsDesiredStateService({
      ops: makeOps(),
      repositories: makeRepositories({ conversations }),
      clock: { now: () => '2026-05-02T00:00:00.000Z' },
    });

    await service.reconcile(settings);

    expect(
      conversations.findConversationByExternalValue,
    ).not.toHaveBeenCalled();
    expect(conversations.saveConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'conversation:tg:C123',
        providerConnectionId: 'telegram_default',
        title: 'Telegram C123',
      }),
    );
    expect(conversations.saveConversation).not.toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'conversation:sl:C123',
        providerConnectionId: 'telegram_default',
      }),
    );
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

  it('does not borrow exported approvers from another provider external ID collision', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.providers.telegram = {
      enabled: true,
      defaultConnection: 'telegram_default',
    };
    settings.providerConnections.telegram_default = {
      provider: 'telegram',
      label: 'Telegram',
      runtimeSecretRefs: { bot_token: 'TELEGRAM_BOT_TOKEN' },
    };
    const slackConversation = {
      id: 'conversation:sl:-100123',
      appId: 'default',
      providerConnectionId: 'slack_default',
      externalRef: { kind: 'conversation', value: '-100123' },
      kind: 'channel',
      title: 'Slack -100123',
      status: 'active',
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
    };
    const conversations = {
      getConversationByExternalRef: vi.fn(async () => null),
      getConversation: vi.fn(async () => null),
      findConversationByExternalValue: vi.fn(async () => slackConversation),
      listConversationApprovers: vi.fn(async () => [
        {
          conversationId: slackConversation.id,
          externalUserId: 'U123',
          createdAt: '2026-05-01T00:00:00.000Z',
          updatedAt: '2026-05-01T00:00:00.000Z',
        },
      ]),
    };
    const service = new SettingsDesiredStateService({
      ops: makeOps({
        'tg:-100123': {
          name: 'Telegram Group',
          folder: 'main_agent',
          trigger: '@Main Agent',
          added_at: '2026-05-01T00:00:00.000Z',
          requiresTrigger: false,
          isMain: true,
        },
      }),
      repositories: makeRepositories({ conversations }),
    });

    const exported = await service.exportCurrent(settings);

    expect(
      conversations.findConversationByExternalValue,
    ).not.toHaveBeenCalled();
    expect(exported.conversations.main_agent_telegram).toEqual(
      expect.objectContaining({
        providerConnection: 'telegram_default',
        externalId: '-100123',
        controlApprovers: [],
      }),
    );
  });

  it('exports canonical provider conversations without duplicate settings entries', async () => {
    const settings = createDefaultRuntimeSettings();
    settings.providers.telegram = {
      enabled: true,
      defaultConnection: 'telegram_default',
    };
    settings.providerConnections.telegram_default = {
      provider: 'telegram',
      label: 'Telegram',
      runtimeSecretRefs: { bot_token: 'TELEGRAM_BOT_TOKEN' },
    };
    settings.conversations.main_agent_telegram = {
      providerConnection: 'telegram_default',
      externalId: '-100123',
      kind: 'group',
      displayName: 'Generated Group',
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: [],
    };
    settings.conversations.main_telegram_group = {
      providerConnection: 'telegram_default',
      externalId: '-100123',
      kind: 'group',
      displayName: 'Main Agent Telegram Group',
      senderPolicy: { allow: '*', mode: 'trigger' },
      controlApprovers: ['5759865942'],
    };
    settings.bindings.main_agent_telegram = {
      agent: 'main_agent',
      conversation: 'main_agent_telegram',
      trigger: '@Main Agent',
      addedAt: '2026-05-01T00:00:00.000Z',
      requiresTrigger: false,
      isMain: true,
      memoryScope: 'conversation',
    };
    settings.bindings.main_telegram_group = {
      agent: 'main_agent',
      conversation: 'main_telegram_group',
      trigger: '@Main Agent',
      addedAt: '2026-05-01T00:00:00.000Z',
      requiresTrigger: false,
      isMain: true,
      memoryScope: 'conversation',
    };
    const service = new SettingsDesiredStateService({
      ops: makeOps({
        'tg:-100123': {
          name: 'Main Agent Telegram Group',
          folder: 'main_agent',
          trigger: '@Main Agent',
          added_at: '2026-05-01T00:00:00.000Z',
          requiresTrigger: false,
          isMain: true,
        },
      }),
      repositories: makeRepositories(),
    });

    const exported = await service.exportCurrent(settings);

    const exportedConversations = Object.entries(exported.conversations).filter(
      ([, conversation]) =>
        conversation.providerConnection === 'telegram_default' &&
        conversation.externalId === '-100123',
    );
    expect(exportedConversations).toEqual([
      [
        'main_telegram_group',
        expect.objectContaining({
          controlApprovers: ['5759865942'],
          displayName: 'Main Agent Telegram Group',
        }),
      ],
    ]);
    expect(Object.values(exported.bindings)).toEqual([
      expect.objectContaining({ conversation: 'main_telegram_group' }),
    ]);
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
