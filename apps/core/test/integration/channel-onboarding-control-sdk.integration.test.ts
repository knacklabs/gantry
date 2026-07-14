import fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createClient } from '../../../../packages/sdk/src/index.js';
import { startTestControlServer } from '../harness/control-http-server.js';
import {
  ConversationInstallResponseSchema,
  ConversationInstallListResponseSchema,
  ProviderAccountResponseSchema,
  ProviderListResponseSchema,
} from '@gantry/contracts';
import { syncRuntimeSettingsFromProjection } from '@core/config/index.js';
import { makeAgentThreadQueueKey } from '@core/shared/thread-queue-key.js';

const state = vi.hoisted(() => ({
  providerAccounts: new Map<string, any>(),
  conversations: new Map<string, any>(),
  threads: new Map<string, any>(),
  conversationInstalls: new Map<string, any>(),
}));

vi.mock('@core/config/index.js', () => ({
  GANTRY_HOME: '/tmp/gantry-channel-integration-home',
  getControlEnvValue: vi.fn((key: string) => process.env[key]?.trim() || ''),
  syncRuntimeSettingsFromProjection: vi.fn(async () => undefined),
  getDefaultModelConfig: vi.fn(() => ({
    model: 'opus',
    source: 'system default',
  })),
  getSelectedAgentHarness: vi.fn(() => 'auto'),
  getRuntimeModelDefaults: vi.fn(() => ({ defaults: {} })),
  patchRuntimeModelDefaults: vi.fn(() => ({ ok: true })),
  configureDesiredSettingsStorageProvider: vi.fn(() => undefined),
}));

vi.mock('@core/jobs/scheduler.js', () => ({
  enqueueJobTrigger: vi.fn(async () => undefined),
  isJobTriggerQueueReady: vi.fn(() => true),
  isSchedulerReady: vi.fn(() => true),
  runtimeJobSchedulePlanner: {
    createManualJobId: () => 'job-test',
    createJobId: () => 'job-test',
    planAppSchedule: () => ({
      scheduleType: 'manual',
      scheduleValue: 'manual',
      nextRun: null,
    }),
    planInitial: () => ({ nextRun: '2026-04-24T01:00:00.000Z' }),
    planResume: ({ job, clock }) =>
      job.next_run ??
      (job.schedule_type === 'manual'
        ? null
        : job.schedule_type === 'once'
          ? job.schedule_value
          : clock.now()),
  },
  requestSchedulerSync: vi.fn(),
}));

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => {
  const providerAccounts = {
    listProviderAccounts: vi.fn(async (appId: string) =>
      [...state.providerAccounts.values()].filter(
        (providerAccount) => providerAccount.appId === appId,
      ),
    ),
    getProviderAccount: vi.fn(
      async (id: string) => state.providerAccounts.get(id) ?? null,
    ),
    saveProviderAccount: vi.fn(async (providerAccount: any) => {
      state.providerAccounts.set(providerAccount.id, providerAccount);
    }),
    updateProviderAccount: vi.fn(async (input: any) => {
      const existing = state.providerAccounts.get(input.id);
      if (!existing || existing.appId !== input.appId) return null;
      const updated = {
        ...existing,
        ...input.patch,
        updatedAt: input.updatedAt,
      };
      if (input.patch.externalInstallationRef === undefined) {
        updated.externalInstallationRef = existing.externalInstallationRef;
      }
      state.providerAccounts.set(updated.id, updated);
      return updated;
    }),
    disableProviderAccount: vi.fn(async (input: any) => {
      const existing = state.providerAccounts.get(input.id);
      if (!existing || existing.appId !== input.appId) return null;
      const disabled = {
        ...existing,
        status: 'disabled',
        updatedAt: input.updatedAt,
      };
      state.providerAccounts.set(disabled.id, disabled);
      return disabled;
    }),
    saveConversationInstall: vi.fn(async (conversationInstall: any) => {
      state.conversationInstalls.set(
        `${conversationInstall.appId}:${conversationInstall.agentId}:${conversationInstall.conversationId}:${conversationInstall.threadId ?? ''}`,
        conversationInstall,
      );
    }),
    disableConversationInstall: vi.fn(async (input: any) => {
      const key = `${input.appId}:${input.agentId}:${input.conversationId}:${input.threadId ?? ''}`;
      const existing = state.conversationInstalls.get(key);
      if (!existing) return null;
      const disabled = {
        ...existing,
        status: 'disabled',
        updatedAt: input.updatedAt,
      };
      state.conversationInstalls.set(key, disabled);
      return disabled;
    }),
    getConversationInstall: vi.fn(async (input: any) => {
      return (
        state.conversationInstalls.get(
          `${input.appId}:${input.agentId}:${input.conversationId}:${input.threadId ?? ''}`,
        ) ?? null
      );
    }),
    isAgentEnabledInConversation: vi.fn(async (input: any) => {
      const conversationInstall = state.conversationInstalls.get(
        `${input.appId}:${input.agentId}:${input.conversationId}:${input.threadId ?? ''}`,
      );
      return conversationInstall?.status === 'active';
    }),
    listConversationInstalls: vi.fn(async (appId: string, agentId?: string) =>
      [...state.conversationInstalls.values()].filter(
        (conversationInstall) =>
          conversationInstall.appId === appId &&
          (!agentId || conversationInstall.agentId === agentId),
      ),
    ),
    listConversationInstallsByConversation: vi.fn(async (input: any) =>
      [...state.conversationInstalls.values()].filter(
        (conversationInstall) =>
          conversationInstall.appId === input.appId &&
          conversationInstall.conversationId === input.conversationId,
      ),
    ),
  };
  const conversations = {
    listConversations: vi.fn(async (input: any) =>
      [...state.conversations.values()].filter(
        (conversation) =>
          conversation.appId === input.appId &&
          (!input.providerAccountId ||
            conversation.providerAccountId === input.providerAccountId),
      ),
    ),
    getConversation: vi.fn(
      async (id: string) => state.conversations.get(id) ?? null,
    ),
    getConversationByExternalRef: vi.fn(async (input: any) => {
      return (
        [...state.conversations.values()].find(
          (conversation) =>
            conversation.appId === input.appId &&
            conversation.providerAccountId === input.providerAccountId &&
            conversation.externalRef?.value === input.externalConversationId,
        ) ?? null
      );
    }),
    getThread: vi.fn(async (id: string) => state.threads.get(id) ?? null),
    getThreadByExternalRef: vi.fn(async () => null),
    saveConversation: vi.fn(async (conversation: any) => {
      state.conversations.set(conversation.id, conversation);
    }),
    saveThread: vi.fn(async (thread: any) => {
      state.threads.set(thread.id, thread);
    }),
    listThreads: vi.fn(async (conversationId: string) =>
      [...state.threads.values()].filter(
        (thread) => thread.conversationId === conversationId,
      ),
    ),
    listConversationApprovers: vi.fn(async () => []),
    listConversationApproversForConversations: vi.fn(async () => []),
  };
  return {
    getRuntimeControlRepository: () => ({
      listDueWebhookDeliveries: vi.fn(async () => []),
      claimDueWebhookDeliveries: vi.fn(async () => []),
    }),
    getRuntimeRepositories: () => ({
      getAllConversationRoutes: vi.fn(async () => ({})),
      storeChatMetadata: vi.fn(async () => undefined),
      storeMessage: vi.fn(async () => undefined),
    }),
    getRuntimeStorage: () => ({
      repositories: {
        agents: {
          listAgents: vi.fn(async (appId: string) => [
            {
              id: 'agent:one',
              appId,
              name: 'Agent One',
              status: 'active',
              createdAt: new Date(0).toISOString(),
              updatedAt: new Date(0).toISOString(),
            },
          ]),
          getAgent: vi.fn(async (agentId: string) => {
            if (agentId === 'agent:one') {
              return {
                id: agentId,
                appId: 'app-one',
                name: 'Agent One',
                status: 'active',
                createdAt: new Date(0).toISOString(),
                updatedAt: new Date(0).toISOString(),
              };
            }
            if (agentId === 'agent:two') {
              return {
                id: agentId,
                appId: 'app-two',
                name: 'Agent Two',
                status: 'active',
                createdAt: new Date(0).toISOString(),
                updatedAt: new Date(0).toISOString(),
              };
            }
            return null;
          }),
        },
        providerAccounts,
        conversations,
        tools: {
          listTools: vi.fn(async () => []),
          getTool: vi.fn(async () => null),
          listAgentToolBindings: vi.fn(async () => []),
          listAgentToolBindingsForAgents: vi.fn(async () => []),
          listAgentToolSources: vi.fn(async () => []),
        },
        skills: {
          getSkill: vi.fn(async () => null),
          listSkills: vi.fn(async () => []),
          listAgentSkillBindings: vi.fn(async () => []),
          listAgentSkillBindingsForAgents: vi.fn(async () => []),
        },
        mcpServers: {
          getServer: vi.fn(async () => null),
          listServers: vi.fn(async () => []),
          listAgentBindings: vi.fn(async () => []),
          listAgentBindingsForAgents: vi.fn(async () => []),
        },
        messages: {
          listMessages: vi.fn(async () => []),
        },
      },
    }),
  };
});

describe('provider conversation onboarding control SDK integration', () => {
  beforeEach(() => {
    fs.rmSync('/tmp/gantry-channel-integration-home', {
      recursive: true,
      force: true,
    });
    state.providerAccounts.clear();
    state.conversations.clear();
    state.threads.clear();
    state.conversationInstalls.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  function runtimeProjectionApp() {
    const registered = new Map<string, any>();
    return {
      registered,
      app: {
        queue: { enqueueMessageCheck: async () => undefined },
        registerGroup: vi.fn(async (jid: string, group: any) => {
          registered.set(jid, group);
        }),
        projectConversationRoute: vi.fn(async (jid: string, group: any) => {
          registered.set(
            makeAgentThreadQueueKey(
              jid,
              `agent:${group.folder}`,
              undefined,
              group.providerAccountId,
            ),
            group,
          );
        }),
        unregisterConversationRoute: vi.fn(async (jid: string) => {
          registered.delete(jid);
        }),
      },
    };
  }

  it('creates provider account and installs an agent with permission policies through SDK/control routes', async () => {
    const runtimeApp = runtimeProjectionApp();
    const server = await startTestControlServer({
      token: 'token-channels',
      appId: 'app-one',
      scopes: [
        'providers:read',
        'providers:admin',
        'conversations:read',
        'conversations:admin',
        'agents:admin',
      ],
      runtimeApp: runtimeApp.app,
    });
    const client = createClient({
      apiKey: server.token,
      baseUrl: server.baseUrl,
      timeoutMs: 3000,
    });

    try {
      const providerList = ProviderListResponseSchema.parse(
        await client.providers.list(),
      );
      expect(providerList.providers.map((provider) => provider.id)).toContain(
        'slack',
      );

      const providerAccount = ProviderAccountResponseSchema.parse(
        await client.providerAccounts.create({
          appId: 'app-one',
          agentId: 'agent:one',
          providerId: 'slack',
          label: 'Engineering Slack',
          externalRef: { kind: 'provider_account', id: 'T123' },
          config: { workspace: 'engineering' },
          runtimeSecretRefs: { bot_token: 'env:SLACK_BOT_TOKEN' },
        }),
      );
      expect(providerAccount).toMatchObject({
        appId: 'app-one',
        providerId: 'slack',
        status: 'active',
        runtimeSecretRefs: { bot_token: 'env:SLACK_BOT_TOKEN' },
      });
      expect(syncRuntimeSettingsFromProjection).toHaveBeenCalledTimes(1);
      expect(syncRuntimeSettingsFromProjection).toHaveBeenLastCalledWith(
        expect.objectContaining({ appId: 'app-one' }),
      );

      const conversation = {
        id: 'conversation:slack:C123',
        appId: 'app-one',
        providerAccountId: providerAccount.id,
        externalRef: { kind: 'conversation', value: 'C123' },
        kind: 'channel',
        title: 'engineering',
        status: 'active',
        createdAt: '2026-04-28T00:00:00.000Z',
        updatedAt: '2026-04-28T00:00:00.000Z',
      };
      state.conversations.set(conversation.id, conversation);
      state.threads.set('thread:slack:C123:1700.1', {
        id: 'thread:slack:C123:1700.1',
        appId: 'app-one',
        conversationId: conversation.id,
        externalRef: { kind: 'conversation_thread', value: '1700.1' },
        title: 'deployment',
        status: 'active',
        createdAt: '2026-04-28T00:00:00.000Z',
        updatedAt: '2026-04-28T00:00:00.000Z',
      });

      const conversationInstall = ConversationInstallResponseSchema.parse(
        await client.agents.conversationInstalls.enable(
          'agent:one',
          conversation.id,
          {
            providerAccountId: providerAccount.id,
            displayName: 'Engineering',
            permissionPolicyIds: ['permission-policy:deploy'],
            memoryScope: 'conversation',
            threadId: 'thread:slack:C123:1700.1',
          },
        ),
      );
      expect(conversationInstall).toMatchObject({
        appId: 'app-one',
        agentId: 'agent:one',
        providerAccountId: providerAccount.id,
        conversationId: conversation.id,
        displayName: 'Engineering',
        permissionPolicyIds: ['permission-policy:deploy'],
      });
      expect(conversationInstall.memorySubject).toMatchObject({
        type: 'conversation',
        id: conversation.id,
      });
      const threadRouteJid = makeAgentThreadQueueKey(
        'sl:C123',
        undefined,
        '1700.1',
      );
      const projectedThreadRouteKey = makeAgentThreadQueueKey(
        'sl:C123',
        'agent:one',
        '1700.1',
        providerAccount.id,
      );
      expect(runtimeApp.app.projectConversationRoute).toHaveBeenCalledWith(
        threadRouteJid,
        expect.objectContaining({
          name: 'Engineering',
          folder: 'one',
          providerAccountId: providerAccount.id,
          requiresTrigger: true,
          conversationKind: 'channel',
        }),
      );
      expect(runtimeApp.app.registerGroup).not.toHaveBeenCalled();
      expect(runtimeApp.registered.has('sl:C123')).toBe(false);
      expect(runtimeApp.registered.has(projectedThreadRouteKey)).toBe(true);
      expect(syncRuntimeSettingsFromProjection).toHaveBeenCalledTimes(2);
      expect(syncRuntimeSettingsFromProjection).toHaveBeenLastCalledWith(
        expect.objectContaining({ appId: 'app-one' }),
      );

      const listed = await client.agents.conversationInstalls.list('agent:one');
      const parsedList = ConversationInstallListResponseSchema.parse(listed);
      expect(parsedList.conversationInstalls.map((entry) => entry.id)).toEqual([
        conversationInstall.id,
      ]);

      await client.agents.conversationInstalls.disable(
        'agent:one',
        conversation.id,
        { threadId: 'thread:slack:C123:1700.1' },
      );
      expect(runtimeApp.app.unregisterConversationRoute).toHaveBeenCalledWith(
        projectedThreadRouteKey,
      );
      expect(runtimeApp.registered.has(projectedThreadRouteKey)).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('projects whole-conversation install disable out of live runtime routing', async () => {
    const runtimeApp = runtimeProjectionApp();
    const server = await startTestControlServer({
      token: 'token-channels',
      appId: 'app-one',
      scopes: ['conversations:admin', 'agents:admin'],
      runtimeApp: runtimeApp.app,
    });
    const client = createClient({
      apiKey: server.token,
      baseUrl: server.baseUrl,
      timeoutMs: 3000,
    });

    const providerAccountId = 'providerAccount:slack:disable';
    const conversationId = 'conversation:slack:disable';
    state.providerAccounts.set(providerAccountId, {
      id: providerAccountId,
      appId: 'app-one',
      agentId: 'agent:one',
      providerId: 'slack',
      label: 'Slack',
      status: 'active',
      config: {},
      runtimeSecretRefs: {},
      createdAt: '2026-04-28T00:00:00.000Z',
      updatedAt: '2026-04-28T00:00:00.000Z',
    });
    state.conversations.set(conversationId, {
      id: conversationId,
      appId: 'app-one',
      providerAccountId,
      externalRef: { kind: 'conversation', value: 'C999' },
      kind: 'channel',
      title: 'ops',
      status: 'active',
      createdAt: '2026-04-28T00:00:00.000Z',
      updatedAt: '2026-04-28T00:00:00.000Z',
    });

    try {
      await client.agents.conversationInstalls.enable(
        'agent:one',
        conversationId,
        {
          providerAccountId,
          displayName: 'Ops',
        },
      );
      expect(
        runtimeApp.registered.has(
          makeAgentThreadQueueKey(
            'sl:C999',
            'agent:one',
            undefined,
            providerAccountId,
          ),
        ),
      ).toBe(true);
      expect(runtimeApp.app.projectConversationRoute).toHaveBeenCalledWith(
        'sl:C999',
        expect.objectContaining({
          name: 'Ops',
          folder: 'one',
          providerAccountId,
          requiresTrigger: true,
          conversationKind: 'channel',
        }),
      );
      expect(runtimeApp.app.registerGroup).not.toHaveBeenCalled();
      await expect(client.agents.getAdmin('agent:one')).resolves.toEqual(
        expect.objectContaining({
          boundConversations: [
            expect.objectContaining({
              conversationId,
              requiresTrigger: true,
            }),
          ],
        }),
      );

      const installKey = `app-one:agent:one:${conversationId}:`;
      state.conversationInstalls.set(installKey, {
        ...state.conversationInstalls.get(installKey),
        memorySubject: {
          ...state.conversationInstalls.get(installKey).memorySubject,
          route: { trigger: '/ops', requiresTrigger: true },
        },
      });
      await client.agents.conversationInstalls.update(
        'agent:one',
        conversationId,
        {
          displayName: 'Ops Updated',
        },
      );
      expect(runtimeApp.app.projectConversationRoute).toHaveBeenLastCalledWith(
        'sl:C999',
        expect.objectContaining({
          trigger: '/ops',
          requiresTrigger: true,
        }),
      );
      await expect(client.agents.getAdmin('agent:one')).resolves.toEqual(
        expect.objectContaining({
          boundConversations: [
            expect.objectContaining({
              conversationId,
              requiresTrigger: true,
              trigger: '/ops',
            }),
          ],
        }),
      );

      await client.agents.conversationInstalls.disable(
        'agent:one',
        conversationId,
      );
      expect(runtimeApp.app.unregisterConversationRoute).toHaveBeenCalledWith(
        makeAgentThreadQueueKey(
          'sl:C999',
          'agent:one',
          undefined,
          providerAccountId,
        ),
      );
      expect(
        runtimeApp.registered.has(
          makeAgentThreadQueueKey(
            'sl:C999',
            'agent:one',
            undefined,
            providerAccountId,
          ),
        ),
      ).toBe(false);

      state.conversations.set('conversation:slack:dm', {
        id: 'conversation:slack:dm',
        appId: 'app-one',
        providerAccountId,
        externalRef: { kind: 'conversation', value: 'D123' },
        kind: 'direct',
        title: 'dm',
        status: 'active',
        createdAt: '2026-04-28T00:00:00.000Z',
        updatedAt: '2026-04-28T00:00:00.000Z',
      });
      await client.agents.conversationInstalls.enable(
        'agent:one',
        'conversation:slack:dm',
        {
          providerAccountId,
          displayName: 'Direct',
        },
      );
      expect(runtimeApp.app.projectConversationRoute).toHaveBeenLastCalledWith(
        'sl:D123',
        expect.objectContaining({
          requiresTrigger: false,
          conversationKind: 'dm',
        }),
      );
    } finally {
      await server.close();
    }
  });

  it('blocks cross-app provider account and conversation install requests before mutation', async () => {
    const server = await startTestControlServer({
      token: 'token-channels',
      appId: 'app-one',
      scopes: ['providers:admin', 'conversations:admin', 'agents:admin'],
    });
    const client = createClient({
      apiKey: server.token,
      baseUrl: server.baseUrl,
      timeoutMs: 3000,
    });

    try {
      await expect(
        client.providerAccounts.create({
          appId: 'app-two',
          agentId: 'agent:one',
          providerId: 'slack',
          label: 'Wrong app',
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(state.providerAccounts).toHaveLength(0);

      state.providerAccounts.set('channel-providerAccount:one', {
        id: 'channel-providerAccount:one',
        appId: 'app-one',
        providerId: 'slack',
        label: 'Engineering Slack',
        status: 'active',
        config: {},
        runtimeSecretRefs: {},
        createdAt: '2026-04-28T00:00:00.000Z',
        updatedAt: '2026-04-28T00:00:00.000Z',
      });
      state.conversations.set('conversation:one', {
        id: 'conversation:one',
        appId: 'app-one',
        providerAccountId: 'channel-providerAccount:one',
        kind: 'channel',
        title: 'engineering',
        status: 'active',
        createdAt: '2026-04-28T00:00:00.000Z',
        updatedAt: '2026-04-28T00:00:00.000Z',
      });

      await expect(
        client.agents.conversationInstalls.enable(
          'agent:two',
          'conversation:one',
          {
            providerAccountId: 'channel-providerAccount:one',
          },
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(state.conversationInstalls).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it('supports reserved URL ids and thread-scoped disable for conversation installs', async () => {
    const server = await startTestControlServer({
      token: 'token-channels',
      appId: 'app-one',
      scopes: ['conversations:read', 'conversations:admin', 'agents:admin'],
    });
    const client = createClient({
      apiKey: server.token,
      baseUrl: server.baseUrl,
      timeoutMs: 3000,
    });

    const providerAccountId = 'channel-providerAccount/slash';
    const conversationId = 'conversation/slash';
    const threadId = 'thread/slash';

    state.providerAccounts.set(providerAccountId, {
      id: providerAccountId,
      appId: 'app-one',
      agentId: 'agent:one',
      providerId: 'slack',
      label: 'Slash Workspace',
      status: 'active',
      config: {},
      runtimeSecretRefs: {},
      createdAt: '2026-04-28T00:00:00.000Z',
      updatedAt: '2026-04-28T00:00:00.000Z',
    });
    state.conversations.set(conversationId, {
      id: conversationId,
      appId: 'app-one',
      providerAccountId: providerAccountId,
      externalRef: { kind: 'conversation', value: 'C/slash' },
      kind: 'channel',
      title: 'slash-room',
      status: 'active',
      createdAt: '2026-04-28T00:00:00.000Z',
      updatedAt: '2026-04-28T00:00:00.000Z',
    });
    state.threads.set(threadId, {
      id: threadId,
      appId: 'app-one',
      conversationId,
      externalRef: { kind: 'conversation_thread', value: '1700/slash' },
      title: 'thread-slash',
      status: 'active',
      createdAt: '2026-04-28T00:00:00.000Z',
      updatedAt: '2026-04-28T00:00:00.000Z',
    });

    try {
      const enabled = ConversationInstallResponseSchema.parse(
        await client.agents.conversationInstalls.enable(
          'agent:one',
          conversationId,
          {
            providerAccountId: providerAccountId,
            threadId,
            displayName: 'Slash Install',
            memoryScope: 'conversation',
          },
        ),
      );
      expect(enabled).toMatchObject({
        appId: 'app-one',
        providerAccountId: providerAccountId,
        conversationId,
        threadId,
        status: 'active',
      });

      const disabled = await client.agents.conversationInstalls.disable(
        'agent:one',
        conversationId,
        {
          threadId,
        },
      );
      expect(disabled.disabled).toBe(true);
      expect(disabled.conversationInstall).toMatchObject({
        conversationId,
        threadId,
        status: 'disabled',
      });

      const listed = ConversationInstallListResponseSchema.parse(
        await client.agents.conversationInstalls.list('agent:one'),
      );
      expect(listed.conversationInstalls).toHaveLength(1);
      expect(listed.conversationInstalls[0]).toMatchObject({
        conversationId,
        threadId,
        status: 'disabled',
      });
    } finally {
      await server.close();
    }
  });

  it('rejects discovery for disabled provider accounts through control SDK routes', async () => {
    const server = await startTestControlServer({
      token: 'token-channels',
      appId: 'app-one',
      scopes: ['providers:read', 'providers:admin'],
    });
    const client = createClient({
      apiKey: server.token,
      baseUrl: server.baseUrl,
      timeoutMs: 3000,
    });

    try {
      const created = ProviderAccountResponseSchema.parse(
        await client.providerAccounts.create({
          appId: 'app-one',
          agentId: 'agent:one',
          providerId: 'slack',
          label: 'To Disable',
        }),
      );
      expect(created.status).toBe('active');

      const disabled = await client.providerAccounts.delete(created.id);
      expect(disabled).toMatchObject({ deleted: true });

      await expect(
        client.providerAccounts.discoverConversations(created.id, {
          limit: 1,
        }),
      ).rejects.toMatchObject({
        code: 'CONFLICT',
      });
    } finally {
      await server.close();
    }
  });
});
