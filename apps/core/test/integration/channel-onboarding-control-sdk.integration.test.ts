import fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createClient } from '../../../../packages/sdk/src/index.js';
import { startTestControlServer } from '../harness/control-http-server.js';
import {
  AgentConversationBindingResponseSchema,
  AgentConversationBindingListResponseSchema,
  ProviderConnectionResponseSchema,
  ProviderListResponseSchema,
} from '@gantry/contracts';
import { syncRuntimeSettingsFromProjection } from '@core/config/index.js';

const state = vi.hoisted(() => ({
  providerConnections: new Map<string, any>(),
  conversations: new Map<string, any>(),
  threads: new Map<string, any>(),
  bindings: new Map<string, any>(),
}));

vi.mock('@core/config/index.js', () => ({
  GANTRY_HOME: '/tmp/gantry-channel-integration-home',
  getControlEnvValue: vi.fn((key: string) => process.env[key]?.trim() || ''),
  syncRuntimeSettingsFromProjection: vi.fn(async () => undefined),
  getDefaultModelConfig: vi.fn(() => ({
    model: 'opus',
    source: 'system default',
  })),
  getRuntimeModelDefaults: vi.fn(() => ({ defaults: {} })),
  patchRuntimeModelDefaults: vi.fn(() => ({ ok: true })),
}));

vi.mock('@core/jobs/scheduler.js', () => ({
  enqueueJobTrigger: vi.fn(async () => undefined),
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
  const providerConnections = {
    listProviderConnections: vi.fn(async (appId: string) =>
      [...state.providerConnections.values()].filter(
        (providerConnection) => providerConnection.appId === appId,
      ),
    ),
    getProviderConnection: vi.fn(
      async (id: string) => state.providerConnections.get(id) ?? null,
    ),
    saveProviderConnection: vi.fn(async (providerConnection: any) => {
      state.providerConnections.set(providerConnection.id, providerConnection);
    }),
    updateProviderConnection: vi.fn(async (input: any) => {
      const existing = state.providerConnections.get(input.id);
      if (!existing || existing.appId !== input.appId) return null;
      const updated = {
        ...existing,
        ...input.patch,
        updatedAt: input.updatedAt,
      };
      if (input.patch.externalInstallationRef === undefined) {
        updated.externalInstallationRef = existing.externalInstallationRef;
      }
      state.providerConnections.set(updated.id, updated);
      return updated;
    }),
    disableProviderConnection: vi.fn(async (input: any) => {
      const existing = state.providerConnections.get(input.id);
      if (!existing || existing.appId !== input.appId) return null;
      const disabled = {
        ...existing,
        status: 'disabled',
        updatedAt: input.updatedAt,
      };
      state.providerConnections.set(disabled.id, disabled);
      return disabled;
    }),
    saveAgentConversationBinding: vi.fn(async (binding: any) => {
      state.bindings.set(
        `${binding.appId}:${binding.agentId}:${binding.conversationId}:${binding.threadId ?? ''}`,
        binding,
      );
    }),
    disableAgentConversationBinding: vi.fn(async (input: any) => {
      const key = `${input.appId}:${input.agentId}:${input.conversationId}:${input.threadId ?? ''}`;
      const existing = state.bindings.get(key);
      if (!existing) return null;
      const disabled = {
        ...existing,
        status: 'disabled',
        updatedAt: input.updatedAt,
      };
      state.bindings.set(key, disabled);
      return disabled;
    }),
    getAgentConversationBinding: vi.fn(async (input: any) => {
      return (
        state.bindings.get(
          `${input.appId}:${input.agentId}:${input.conversationId}:${input.threadId ?? ''}`,
        ) ?? null
      );
    }),
    isAgentEnabledInConversation: vi.fn(async (input: any) => {
      const binding = state.bindings.get(
        `${input.appId}:${input.agentId}:${input.conversationId}:${input.threadId ?? ''}`,
      );
      return binding?.status === 'active';
    }),
    listAgentConversationBindings: vi.fn(
      async (appId: string, agentId?: string) =>
        [...state.bindings.values()].filter(
          (binding) =>
            binding.appId === appId &&
            (!agentId || binding.agentId === agentId),
        ),
    ),
    listAgentConversationBindingsByConversation: vi.fn(async (input: any) =>
      [...state.bindings.values()].filter(
        (binding) =>
          binding.appId === input.appId &&
          binding.conversationId === input.conversationId,
      ),
    ),
  };
  const conversations = {
    listConversations: vi.fn(async (input: any) =>
      [...state.conversations.values()].filter(
        (conversation) =>
          conversation.appId === input.appId &&
          (!input.providerConnectionId ||
            conversation.providerConnectionId === input.providerConnectionId),
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
            conversation.providerConnectionId === input.providerConnectionId &&
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
        providerConnections,
        conversations,
        tools: {
          listTools: vi.fn(async () => []),
          listAgentToolBindingsForAgents: vi.fn(async () => []),
        },
        skills: {
          listAgentSkillBindingsForAgents: vi.fn(async () => []),
        },
        mcpServers: {
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
    state.providerConnections.clear();
    state.conversations.clear();
    state.threads.clear();
    state.bindings.clear();
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
          registered.set(jid, group);
        }),
        unregisterConversationRoute: vi.fn(async (jid: string) => {
          registered.delete(jid);
        }),
      },
    };
  }

  it('creates provider connection and binds an agent with permission policies through SDK/control routes', async () => {
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

      const providerConnection = ProviderConnectionResponseSchema.parse(
        await client.providerConnections.create({
          appId: 'app-one',
          providerId: 'slack',
          label: 'Engineering Slack',
          externalRef: { kind: 'provider_connection', id: 'T123' },
          config: { workspace: 'engineering' },
          runtimeSecretRefs: ['SLACK_BOT_TOKEN'],
        }),
      );
      expect(providerConnection).toMatchObject({
        appId: 'app-one',
        providerId: 'slack',
        status: 'active',
        runtimeSecretRefs: ['SLACK_BOT_TOKEN'],
      });
      expect(syncRuntimeSettingsFromProjection).toHaveBeenCalledTimes(1);
      expect(syncRuntimeSettingsFromProjection).toHaveBeenLastCalledWith(
        expect.objectContaining({ appId: 'app-one' }),
      );

      const conversation = {
        id: 'conversation:slack:C123',
        appId: 'app-one',
        providerConnectionId: providerConnection.id,
        providerConnectionId: providerConnection.id,
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

      const binding = AgentConversationBindingResponseSchema.parse(
        await client.agents.conversationBindings.enable(
          'agent:one',
          conversation.id,
          {
            providerConnectionId: providerConnection.id,
            triggerMode: 'mention',
            displayName: 'Engineering',
            permissionPolicyIds: ['permission-policy:deploy'],
            memoryScope: 'conversation',
            threadId: 'thread:slack:C123:1700.1',
          },
        ),
      );
      expect(binding).toMatchObject({
        appId: 'app-one',
        agentId: 'agent:one',
        providerConnectionId: providerConnection.id,
        conversationId: conversation.id,
        displayName: 'Engineering',
        triggerMode: 'mention',
        requiresTrigger: true,
        permissionPolicyIds: ['permission-policy:deploy'],
      });
      expect(binding.memorySubject).toMatchObject({
        type: 'conversation',
        id: conversation.id,
      });
      expect(runtimeApp.app.projectConversationRoute).not.toHaveBeenCalled();
      expect(runtimeApp.app.registerGroup).not.toHaveBeenCalled();
      expect(runtimeApp.registered.has('sl:C123')).toBe(false);
      expect(syncRuntimeSettingsFromProjection).toHaveBeenCalledTimes(2);
      expect(syncRuntimeSettingsFromProjection).toHaveBeenLastCalledWith(
        expect.objectContaining({ appId: 'app-one' }),
      );

      const listed = await client.agents.conversationBindings.list('agent:one');
      const parsedList =
        AgentConversationBindingListResponseSchema.parse(listed);
      expect(parsedList.bindings.map((entry) => entry.id)).toEqual([
        binding.id,
      ]);
    } finally {
      await server.close();
    }
  });

  it('projects whole-conversation binding disable out of live runtime routing', async () => {
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

    const providerConnectionId = 'providerConnection:slack:disable';
    const conversationId = 'conversation:slack:disable';
    state.providerConnections.set(providerConnectionId, {
      id: providerConnectionId,
      appId: 'app-one',
      providerId: 'slack',
      label: 'Slack',
      status: 'active',
      config: {},
      runtimeSecretRefs: [],
      createdAt: '2026-04-28T00:00:00.000Z',
      updatedAt: '2026-04-28T00:00:00.000Z',
    });
    state.conversations.set(conversationId, {
      id: conversationId,
      appId: 'app-one',
      providerConnectionId,
      externalRef: { kind: 'conversation', value: 'C999' },
      kind: 'channel',
      title: 'ops',
      status: 'active',
      createdAt: '2026-04-28T00:00:00.000Z',
      updatedAt: '2026-04-28T00:00:00.000Z',
    });

    try {
      await client.agents.conversationBindings.enable(
        'agent:one',
        conversationId,
        {
          providerConnectionId,
          displayName: 'Ops',
          triggerMode: 'always',
        },
      );
      expect(runtimeApp.registered.has('sl:C999')).toBe(true);
      expect(runtimeApp.app.projectConversationRoute).toHaveBeenCalledWith(
        'sl:C999',
        expect.objectContaining({
          name: 'Ops',
          folder: 'one',
          conversationKind: 'channel',
        }),
      );
      expect(runtimeApp.app.registerGroup).not.toHaveBeenCalled();

      await client.agents.conversationBindings.disable(
        'agent:one',
        conversationId,
      );
      expect(runtimeApp.app.unregisterConversationRoute).toHaveBeenCalledWith(
        'sl:C999',
      );
      expect(runtimeApp.registered.has('sl:C999')).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('blocks cross-app provider connection and binding requests before mutation', async () => {
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
        client.providerConnections.create({
          appId: 'app-two',
          providerId: 'slack',
          label: 'Wrong app',
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(state.providerConnections).toHaveLength(0);

      state.providerConnections.set('channel-providerConnection:one', {
        id: 'channel-providerConnection:one',
        appId: 'app-one',
        providerId: 'slack',
        label: 'Engineering Slack',
        status: 'active',
        config: {},
        runtimeSecretRefs: [],
        createdAt: '2026-04-28T00:00:00.000Z',
        updatedAt: '2026-04-28T00:00:00.000Z',
      });
      state.conversations.set('conversation:one', {
        id: 'conversation:one',
        appId: 'app-one',
        providerConnectionId: 'channel-providerConnection:one',
        providerConnectionId: 'channel-providerConnection:one',
        kind: 'channel',
        title: 'engineering',
        status: 'active',
        createdAt: '2026-04-28T00:00:00.000Z',
        updatedAt: '2026-04-28T00:00:00.000Z',
      });

      await expect(
        client.agents.conversationBindings.enable(
          'agent:two',
          'conversation:one',
          {
            providerConnectionId: 'channel-providerConnection:one',
          },
        ),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(state.bindings).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it('supports reserved URL ids and thread-scoped disable for conversation bindings', async () => {
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

    const providerConnectionId = 'channel-providerConnection/slash';
    const conversationId = 'conversation/slash';
    const threadId = 'thread/slash';

    state.providerConnections.set(providerConnectionId, {
      id: providerConnectionId,
      appId: 'app-one',
      providerId: 'slack',
      label: 'Slash Workspace',
      status: 'active',
      config: {},
      runtimeSecretRefs: [],
      createdAt: '2026-04-28T00:00:00.000Z',
      updatedAt: '2026-04-28T00:00:00.000Z',
    });
    state.conversations.set(conversationId, {
      id: conversationId,
      appId: 'app-one',
      providerConnectionId: providerConnectionId,
      providerConnectionId: providerConnectionId,
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
      const enabled = AgentConversationBindingResponseSchema.parse(
        await client.agents.conversationBindings.enable(
          'agent:one',
          conversationId,
          {
            providerConnectionId: providerConnectionId,
            threadId,
            displayName: 'Slash Binding',
            triggerMode: 'mention',
            memoryScope: 'conversation',
          },
        ),
      );
      expect(enabled).toMatchObject({
        appId: 'app-one',
        providerConnectionId: providerConnectionId,
        conversationId,
        threadId,
        status: 'active',
      });

      const disabled = await client.agents.conversationBindings.disable(
        'agent:one',
        conversationId,
        {
          threadId,
        },
      );
      expect(disabled.disabled).toBe(true);
      expect(disabled.binding).toMatchObject({
        conversationId,
        threadId,
        status: 'disabled',
      });

      const listed = AgentConversationBindingListResponseSchema.parse(
        await client.agents.conversationBindings.list('agent:one'),
      );
      expect(listed.bindings).toHaveLength(1);
      expect(listed.bindings[0]).toMatchObject({
        conversationId,
        threadId,
        status: 'disabled',
      });
    } finally {
      await server.close();
    }
  });

  it('rejects discovery for disabled provider connections through control SDK routes', async () => {
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
      const created = ProviderConnectionResponseSchema.parse(
        await client.providerConnections.create({
          appId: 'app-one',
          providerId: 'slack',
          label: 'To Disable',
        }),
      );
      expect(created.status).toBe('active');

      const disabled = await client.providerConnections.delete(created.id);
      expect(disabled).toMatchObject({ deleted: true });

      await expect(
        client.providerConnections.discoverConversations(created.id, {
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
