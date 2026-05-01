import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createClient } from '../../../../packages/sdk/src/index.js';
import { startTestControlServer } from '../harness/control-http-server.js';
import {
  AgentChannelBindingResponseSchema,
  AgentChannelBindingListResponseSchema,
  ChannelInstallationResponseSchema,
  ChannelProviderListResponseSchema,
} from '@myclaw/contracts';

const state = vi.hoisted(() => ({
  installations: new Map<string, any>(),
  conversations: new Map<string, any>(),
  threads: new Map<string, any>(),
  bindings: new Map<string, any>(),
}));

vi.mock('@core/config/index.js', () => ({
  MYCLAW_HOME: '/tmp/myclaw-channel-integration-home',
  ONECLI_ALLOWED_ENV_KEYS: [],
  getControlEnvValue: vi.fn((key: string) => process.env[key]?.trim() || ''),
  getDefaultModelConfig: vi.fn(() => ({
    model: 'opus',
    source: 'system default',
  })),
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
  const channelInstallations = {
    listChannelInstallations: vi.fn(async (appId: string) =>
      [...state.installations.values()].filter(
        (installation) => installation.appId === appId,
      ),
    ),
    getChannelInstallation: vi.fn(
      async (id: string) => state.installations.get(id) ?? null,
    ),
    saveChannelInstallation: vi.fn(async (installation: any) => {
      state.installations.set(installation.id, installation);
    }),
    updateChannelInstallation: vi.fn(async (input: any) => {
      const existing = state.installations.get(input.id);
      if (!existing || existing.appId !== input.appId) return null;
      const updated = {
        ...existing,
        ...input.patch,
        updatedAt: input.updatedAt,
      };
      if (input.patch.externalInstallationRef === undefined) {
        updated.externalInstallationRef = existing.externalInstallationRef;
      }
      state.installations.set(updated.id, updated);
      return updated;
    }),
    disableChannelInstallation: vi.fn(async (input: any) => {
      const existing = state.installations.get(input.id);
      if (!existing || existing.appId !== input.appId) return null;
      const disabled = {
        ...existing,
        status: 'disabled',
        updatedAt: input.updatedAt,
      };
      state.installations.set(disabled.id, disabled);
      return disabled;
    }),
    saveAgentChannelBinding: vi.fn(async (binding: any) => {
      state.bindings.set(
        `${binding.appId}:${binding.agentId}:${binding.conversationId}:${binding.threadId ?? ''}`,
        binding,
      );
    }),
    disableAgentChannelBinding: vi.fn(async (input: any) => {
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
    getAgentChannelBinding: vi.fn(async (input: any) => {
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
    listAgentChannelBindings: vi.fn(async (appId: string, agentId?: string) =>
      [...state.bindings.values()].filter(
        (binding) =>
          binding.appId === appId && (!agentId || binding.agentId === agentId),
      ),
    ),
  };
  const conversations = {
    listConversations: vi.fn(async (input: any) =>
      [...state.conversations.values()].filter(
        (conversation) =>
          conversation.appId === input.appId &&
          (!input.channelInstallationId ||
            conversation.channelInstallationId === input.channelInstallationId),
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
            conversation.channelInstallationId ===
              input.channelInstallationId &&
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
  };
  return {
    getRuntimeControlRepository: () => ({
      listDueWebhookDeliveries: vi.fn(async () => []),
      claimDueWebhookDeliveries: vi.fn(async () => []),
    }),
    getRuntimeOpsRepository: () => ({
      storeChatMetadata: vi.fn(async () => undefined),
      storeMessage: vi.fn(async () => undefined),
    }),
    getRuntimeStorage: () => ({
      repositories: {
        agents: {
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
        channelInstallations,
        conversations,
        messages: {
          listMessages: vi.fn(async () => []),
        },
      },
    }),
  };
});

describe('channel onboarding control SDK integration', () => {
  beforeEach(() => {
    state.installations.clear();
    state.conversations.clear();
    state.threads.clear();
    state.bindings.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('creates channel installation and binds an agent with permission policies through SDK/control routes', async () => {
    const server = await startTestControlServer({
      token: 'token-channels',
      appId: 'app-one',
      scopes: [
        'channels:read',
        'channels:admin',
        'conversations:read',
        'agents:admin',
      ],
    });
    const client = createClient({
      apiKey: server.token,
      baseUrl: server.baseUrl,
      timeoutMs: 3000,
    });

    try {
      const providerList = ChannelProviderListResponseSchema.parse(
        await client.channels.providers.list(),
      );
      expect(providerList.providers.map((provider) => provider.id)).toContain(
        'slack',
      );

      const installation = ChannelInstallationResponseSchema.parse(
        await client.channels.installations.create({
          appId: 'app-one',
          providerId: 'slack',
          label: 'Engineering Slack',
          externalRef: { kind: 'channel_installation', id: 'T123' },
          config: { workspace: 'engineering' },
          runtimeSecretRefs: ['SLACK_BOT_TOKEN'],
        }),
      );
      expect(installation).toMatchObject({
        appId: 'app-one',
        providerId: 'slack',
        status: 'active',
        runtimeSecretRefs: ['SLACK_BOT_TOKEN'],
      });

      const conversation = {
        id: 'conversation:slack:C123',
        appId: 'app-one',
        channelInstallationId: installation.id,
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

      const binding = AgentChannelBindingResponseSchema.parse(
        await client.agents.bindings.enable('agent:one', conversation.id, {
          channelInstallationId: installation.id,
          triggerMode: 'mention',
          displayName: 'Engineering',
          permissionPolicyIds: ['permission-policy:deploy'],
          memoryScope: 'thread',
          threadId: 'thread:slack:C123:1700.1',
        }),
      );
      expect(binding).toMatchObject({
        appId: 'app-one',
        agentId: 'agent:one',
        channelInstallationId: installation.id,
        conversationId: conversation.id,
        displayName: 'Engineering',
        triggerMode: 'mention',
        requiresTrigger: true,
        permissionPolicyIds: ['permission-policy:deploy'],
      });
      expect(binding.memorySubject).toMatchObject({
        type: 'thread',
        id: 'thread:slack:C123:1700.1',
      });

      const listed = await client.agents.bindings.list('agent:one');
      const parsedList = AgentChannelBindingListResponseSchema.parse(listed);
      expect(parsedList.bindings.map((entry) => entry.id)).toEqual([
        binding.id,
      ]);
    } finally {
      await server.close();
    }
  });

  it('blocks cross-app channel installation and binding requests before mutation', async () => {
    const server = await startTestControlServer({
      token: 'token-channels',
      appId: 'app-one',
      scopes: ['channels:admin', 'agents:admin'],
    });
    const client = createClient({
      apiKey: server.token,
      baseUrl: server.baseUrl,
      timeoutMs: 3000,
    });

    try {
      await expect(
        client.channels.installations.create({
          appId: 'app-two',
          providerId: 'slack',
          label: 'Wrong app',
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(state.installations).toHaveLength(0);

      state.installations.set('channel-installation:one', {
        id: 'channel-installation:one',
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
        channelInstallationId: 'channel-installation:one',
        kind: 'channel',
        title: 'engineering',
        status: 'active',
        createdAt: '2026-04-28T00:00:00.000Z',
        updatedAt: '2026-04-28T00:00:00.000Z',
      });

      await expect(
        client.agents.bindings.enable('agent:two', 'conversation:one', {
          channelInstallationId: 'channel-installation:one',
        }),
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
      expect(state.bindings).toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it('supports reserved URL ids and thread-scoped disable for channel bindings', async () => {
    const server = await startTestControlServer({
      token: 'token-channels',
      appId: 'app-one',
      scopes: ['channels:read', 'agents:admin'],
    });
    const client = createClient({
      apiKey: server.token,
      baseUrl: server.baseUrl,
      timeoutMs: 3000,
    });

    const installationId = 'channel-installation/slash';
    const conversationId = 'conversation/slash';
    const threadId = 'thread/slash';

    state.installations.set(installationId, {
      id: installationId,
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
      channelInstallationId: installationId,
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
      const enabled = AgentChannelBindingResponseSchema.parse(
        await client.agents.bindings.enable('agent:one', conversationId, {
          channelInstallationId: installationId,
          threadId,
          displayName: 'Slash Binding',
          triggerMode: 'mention',
          memoryScope: 'thread',
        }),
      );
      expect(enabled).toMatchObject({
        appId: 'app-one',
        channelInstallationId: installationId,
        conversationId,
        threadId,
        status: 'active',
      });

      const disabled = await client.agents.bindings.disable(
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

      const listed = AgentChannelBindingListResponseSchema.parse(
        await client.agents.bindings.list('agent:one'),
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

  it('rejects discovery for disabled installations through control SDK routes', async () => {
    const server = await startTestControlServer({
      token: 'token-channels',
      appId: 'app-one',
      scopes: ['channels:read', 'channels:admin'],
    });
    const client = createClient({
      apiKey: server.token,
      baseUrl: server.baseUrl,
      timeoutMs: 3000,
    });

    try {
      const created = ChannelInstallationResponseSchema.parse(
        await client.channels.installations.create({
          appId: 'app-one',
          providerId: 'slack',
          label: 'To Disable',
        }),
      );
      expect(created.status).toBe('active');

      const disabled = await client.channels.installations.delete(created.id);
      expect(disabled).toMatchObject({ deleted: true });

      await expect(
        client.channels.installations.discover(created.id, { limit: 1 }),
      ).rejects.toMatchObject({
        code: 'CONFLICT',
      });
    } finally {
      await server.close();
    }
  });
});
