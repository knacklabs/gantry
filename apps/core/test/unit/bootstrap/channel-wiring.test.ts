import { describe, expect, it, vi } from 'vitest';

vi.mock('@core/platform/sender-allowlist.js', () => ({
  loadSenderAllowlist: vi.fn(() => ({})),
  loadSenderControlAllowlist: vi.fn(() => ({})),
  shouldDropMessage: vi.fn(() => false),
  isSenderAllowed: vi.fn(() => true),
  isSenderControlAllowed: vi.fn(() => true),
  shouldLogDenied: vi.fn(() => false),
}));

const runtimeStoreMock = vi.hoisted(() => ({
  opsRepository: {
    storeMessage: vi.fn(async () => undefined),
    storeChatMetadata: vi.fn(async () => undefined),
  },
  repositories: {
    agents: {
      findAgentsByDmAccess: vi.fn(async () => []),
      listAgentDmApprovers: vi.fn(async () => []),
    },
    providerConnections: {
      getProviderConnection: vi.fn(async () => null),
      saveAgentConversationBinding: vi.fn(async () => undefined),
      listAgentConversationBindings: vi.fn(async () => []),
      listAgentConversationBindingsByConversation: vi.fn(async () => []),
    },
    conversations: {
      getConversation: vi.fn(async () => null),
      listConversationApprovers: vi.fn(async () => []),
    },
  },
}));

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getRuntimeStorage: () => ({ repositories: runtimeStoreMock.repositories }),
  getRuntimeOpsRepository: () => runtimeStoreMock.opsRepository,
  tryAcquireRuntimeAdvisoryLease: vi.fn(async () => true),
}));

import { RuntimeSettings } from '@core/config/settings/runtime-settings.js';
import { ChannelAdapter } from '@core/channels/channel-provider.js';
import { Provider } from '@core/channels/provider-registry.js';
import { AsyncTaskQueue } from '@core/app/bootstrap/async-task-queue.js';
import { createChannelPersistenceHandlers } from '@core/app/bootstrap/channel-persistence-handlers.js';
import { createChannelWiring } from '@core/app/bootstrap/channel-wiring.js';
import { RuntimeApp } from '@core/app/bootstrap/runtime-app.js';

function makeRuntimeSettings(enabled: {
  telegram: boolean;
  slack: boolean;
}): RuntimeSettings {
  const allowlist = {
    default: { allow: '*', mode: 'trigger' as const },
    agents: {},
    logDenied: true,
  };
  return {
    providers: {
      telegram: { enabled: enabled.telegram },
      slack: { enabled: enabled.slack },
    },
    memory: {
      enabled: true,
      embeddings: {
        enabled: false,
        provider: 'disabled',
        model: 'text-embedding-3-large',
      },
      dreaming: {
        enabled: false,
      },
      llm: {
        models: {
          extractor: 'haiku',
          dreaming: 'sonnet',
          consolidation: 'sonnet',
        },
      },
    },
  };
}

function makeChannel(overrides: Partial<ChannelAdapter> = {}): ChannelAdapter {
  return {
    name: 'telegram',
    connect: vi.fn(async () => {}),
    sendMessage: vi.fn(async () => {}),
    isConnected: vi.fn(() => true),
    ownsJid: vi.fn((jid: string) => jid.startsWith('tg:')),
    disconnect: vi.fn(async () => {}),
    ...overrides,
  };
}

function makeApp(registeredGroups: Record<string, any> = {}): RuntimeApp {
  return {
    queue: {} as RuntimeApp['queue'],
    loadState: vi.fn(),
    saveState: vi.fn(),
    getOrRecoverCursor: vi.fn(),
    registerGroup: vi.fn(async (jid: string, group: any) => {
      registeredGroups[jid] = group;
    }),
    setGroupModelOverride: vi.fn(),
    setGroupThinkingOverride: vi.fn(),
    getAvailableGroups: vi.fn(() => []),
    setRegisteredGroupsForTest: vi.fn(),
    ensureCredentialBindingsForRegisteredGroups: vi.fn(),
    processGroupMessages: vi.fn(),
    getRegisteredGroups: vi.fn(() => registeredGroups),
    getLastTimestamp: vi.fn(() => ''),
    setLastTimestamp: vi.fn(),
    setAgentCursor: vi.fn(),
    setChannelRuntime: vi.fn(),
  };
}

function dmAccessTestDeps() {
  return {
    dmAccess: {
      resolveDmAgent: async (input: any) => {
        const agents =
          await runtimeStoreMock.repositories.agents.findAgentsByDmAccess(
            input,
          );
        if (agents.length === 0) return { status: 'none' as const };
        if (agents.length === 1) {
          return { status: 'single' as const, agent: agents[0] };
        }
        return { status: 'ambiguous' as const, agents };
      },
    },
    saveDmAgentConversationBinding: async (input: any) => {
      await runtimeStoreMock.repositories.providerConnections.saveAgentConversationBinding(
        {
          agentId: input.agent.id,
          providerConnectionId: `channel-providerConnection:default:${input.providerId}`,
          conversationId: `conversation:${input.chatJid}`,
          triggerMode: 'always',
        },
      );
    },
  };
}

function makeProvider(
  id: Provider['id'],
  create: Provider['create'],
): Provider {
  return {
    id,
    label: id,
    jidPrefix: id === 'telegram' ? 'tg:' : 'sl:',
    folderPrefix: `${id}_`,
    isGroupJid: (jid: string) =>
      id === 'telegram' ? jid.startsWith('tg:-') : jid.startsWith('sl:'),
    formatting: id === 'telegram' ? 'telegram-html' : 'mrkdwn',
    isEnabled: (settings: RuntimeSettings) =>
      id === 'telegram'
        ? settings.providers.telegram.enabled
        : settings.providers.slack.enabled,
    create,
    setup: {
      envKeys: [],
      describe: () => id,
      run: async () => {},
    },
  };
}

describe('createChannelWiring', () => {
  it('skips disabled channels in runtime settings', async () => {
    const app = makeApp();
    const info = vi.fn();

    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'telegram',
          vi.fn(() => makeChannel()),
        ),
        makeProvider(
          'slack',
          vi.fn(() => makeChannel()),
        ),
      ],
      logger: {
        info,
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      },
    });

    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: false, slack: false }),
    );

    expect(wiring.hasConnectedChannels()).toBe(false);
    expect(info).toHaveBeenCalledTimes(2);
  });

  it('warns and skips when credentials are missing', async () => {
    const app = makeApp();
    const warn = vi.fn();

    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'telegram',
          vi.fn(() => null),
        ),
      ],
      logger: {
        info: vi.fn(),
        warn,
        debug: vi.fn(),
        error: vi.fn(),
      },
    });

    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
    );

    expect(wiring.hasConnectedChannels()).toBe(false);
    expect(warn).toHaveBeenCalledOnce();
  });

  it('drops disallowed inbound sender before persistence', async () => {
    const app = makeApp({
      'tg:123': { name: 'Main', folder: 'main', isMain: true },
    });
    const storeMessage = vi.fn(async () => {});
    let onMessage: ((chatJid: string, msg: any) => Promise<void>) | undefined;

    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider('telegram', (opts: any) => {
          onMessage = opts.onMessage;
          return makeChannel();
        }),
      ],
      opsRepository: { storeMessage } as any,
      loadSenderAllowlist: vi.fn(() => ({}) as any),
      shouldDropMessage: vi.fn(() => true),
      isSenderAllowed: vi.fn(() => false),
      shouldLogDenied: vi.fn(() => true),
    });

    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
    );

    await onMessage?.('tg:123', {
      id: 'm1',
      chat_jid: 'tg:123',
      sender: 'user-1',
      sender_name: 'User',
      content: 'hello',
      timestamp: '2026-01-01T00:00:00.000Z',
      is_from_me: false,
      is_bot_message: false,
    });

    expect(storeMessage).not.toHaveBeenCalled();
  });

  it('routes remote-control commands and does not store as normal messages', async () => {
    const app = makeApp({
      'tg:123': { name: 'Main', folder: 'main', isMain: true },
    });
    const storeMessage = vi.fn(async () => {});
    const handleRemoteControl = vi.fn(async () => {});
    let onMessage: ((chatJid: string, msg: any) => Promise<void>) | undefined;

    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider('telegram', (opts: any) => {
          onMessage = opts.onMessage;
          return makeChannel();
        }),
      ],
      opsRepository: { storeMessage } as any,
      asRemoteControlCommand: vi.fn(() => ({ command: 'start' }) as any),
      handleRemoteControlCommand: handleRemoteControl as any,
    });

    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
    );

    await onMessage?.('tg:123', {
      id: 'm2',
      chat_jid: 'tg:123',
      sender: 'user-1',
      sender_name: 'User',
      content: '/remote start',
      timestamp: '2026-01-01T00:00:00.000Z',
    });

    expect(handleRemoteControl).toHaveBeenCalledOnce();
    expect(storeMessage).not.toHaveBeenCalled();
  });

  it('stores normal inbound messages', async () => {
    const app = makeApp({
      'tg:123': { name: 'Main', folder: 'main', isMain: true },
    });
    const storeMessage = vi.fn(async () => {});
    let onMessage: ((chatJid: string, msg: any) => Promise<void>) | undefined;

    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider('telegram', (opts: any) => {
          onMessage = opts.onMessage;
          return makeChannel();
        }),
      ],
      opsRepository: { storeMessage } as any,
      asRemoteControlCommand: vi.fn(() => null),
      shouldDropMessage: vi.fn(() => false),
    });

    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
    );

    const msg = {
      id: 'm3',
      chat_jid: 'tg:123',
      sender: 'user-1',
      sender_name: 'User',
      content: 'normal message',
      timestamp: '2026-01-01T00:00:00.000Z',
    };

    await onMessage?.('tg:123', msg);

    expect(storeMessage).toHaveBeenCalledWith(msg);
  });

  it('waits for queue capacity when message persistence queue is full', async () => {
    const app = makeApp({
      'tg:123': { name: 'Main', folder: 'main', isMain: true },
    });
    const storeMessage = vi.fn(async () => {});
    const warn = vi.fn();
    const persistenceQueue = new AsyncTaskQueue(1, 1);
    let releaseFirst!: () => void;
    expect(
      persistenceQueue.enqueue(
        () =>
          new Promise<void>((resolve) => {
            releaseFirst = resolve;
          }),
      ),
    ).toBe(true);
    const handlers = createChannelPersistenceHandlers({
      app,
      resolved: {
        providerIds: [],
        loadSenderAllowlist: vi.fn(() => ({}) as any),
        loadSenderControlAllowlist: vi.fn(() => ({}) as any),
        shouldDropMessage: vi.fn(() => false),
        isSenderAllowed: vi.fn(() => true),
        isSenderControlAllowed: vi.fn(() => true),
        shouldLogDenied: vi.fn(() => false),
        asRemoteControlCommand: vi.fn(() => null),
        handleRemoteControlCommand: vi.fn(async () => {}),
        logger: {
          info: vi.fn(),
          warn,
          debug: vi.fn(),
          error: vi.fn(),
        },
        opsRepository: { storeMessage } as any,
      },
      ops: () => ({ storeMessage, storeChatMetadata: vi.fn() }) as any,
      findBoundChannel: vi.fn(),
      persistenceQueue,
    });

    const msg = {
      id: 'm4',
      chat_jid: 'tg:123',
      sender: 'user-1',
      sender_name: 'User',
      content: 'normal message',
      timestamp: '2026-01-01T00:00:00.000Z',
    };

    const handled = handlers.onMessage('tg:123', msg);

    await Promise.resolve();
    expect(storeMessage).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      { chatJid: 'tg:123', queueSize: 1 },
      'Persistence queue full; waiting to enqueue message persistence',
    );

    releaseFirst();
    await handled;
    await persistenceQueue.waitForIdle();

    expect(storeMessage).toHaveBeenCalledWith(msg);
  });

  it('formats outbound messages using provider registry id for the jid', async () => {
    const app = makeApp();
    const outbound = makeChannel({
      name: 'telegram-adapter-name',
      ownsJid: vi.fn((jid: string) => jid === 'tg:123'),
    });

    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'telegram',
          vi.fn(() => outbound),
        ),
      ],
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
    );

    await wiring.sendMessage('tg:123', '**done**');
    expect(outbound.sendMessage).toHaveBeenCalledWith('tg:123', '*done*');
  });

  it('records outbound final messages as pending and then sent', async () => {
    const app = makeApp();
    const storeMessage = vi.fn(async () => {});
    const outbound = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'sl:C123'),
      sendMessage: vi.fn(async () => ({ externalMessageId: '171.123' })),
    });

    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'slack',
          vi.fn(() => outbound),
        ),
      ],
      opsRepository: { storeMessage } as any,
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: false, slack: true }),
    );

    await wiring.sendMessage('sl:C123', 'done', {
      messageOptions: { threadId: '1700.1' },
    });

    expect(storeMessage).toHaveBeenCalledTimes(2);
    expect(storeMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        chat_jid: 'sl:C123',
        content: 'done',
        thread_id: '1700.1',
        delivery_status: 'pending',
        is_bot_message: true,
      }),
    );
    expect(storeMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        chat_jid: 'sl:C123',
        external_message_id: '171.123',
        delivery_status: 'sent',
        delivered_at: expect.any(String),
      }),
    );
  });

  it('preserves provider send errors when failure-state persistence fails', async () => {
    const app = makeApp();
    const providerErr = new Error('provider send failed');
    const persistErr = new Error('persist failed');
    const storeMessage = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(persistErr);
    const error = vi.fn();
    const outbound = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'sl:C123'),
      sendMessage: vi.fn(async () => {
        throw providerErr;
      }),
    });

    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'slack',
          vi.fn(() => outbound),
        ),
      ],
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error,
      },
      opsRepository: { storeMessage } as any,
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: false, slack: true }),
    );

    await expect(wiring.sendMessage('sl:C123', 'done')).rejects.toThrow(
      providerErr,
    );

    expect(storeMessage).toHaveBeenCalledTimes(2);
    expect(storeMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        chat_jid: 'sl:C123',
        delivery_status: 'failed',
        delivery_error: 'provider send failed',
      }),
    );
    expect(error).toHaveBeenCalledWith(
      { err: persistErr, jid: 'sl:C123' },
      'Failed to persist outbound delivery failure',
    );
  });

  it('streams group chunks with internal tags removed but without markdown conversion', async () => {
    const app = makeApp();
    const outbound = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'tg:-123'),
    });

    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'telegram',
          vi.fn(() => outbound),
        ),
      ],
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
    );

    const ok = await wiring.sendStreamingChunk(
      'tg:-123',
      '<internal>scratch</internal>**done**',
    );

    expect(ok).toBe(true);
    expect(outbound.sendMessage).toHaveBeenCalledWith('tg:-123', '**done**');
  });

  it('keeps streaming chunks transport-only so the processor persists one final transcript', async () => {
    const app = makeApp();
    const storeMessage = vi.fn(async () => {});
    const streamSink = vi.fn(async () => true);
    const outbound = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'tg:123'),
      sendStreamingChunk: streamSink,
    });

    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'telegram',
          vi.fn(() => outbound),
        ),
      ],
      opsRepository: { storeMessage } as any,
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
    );

    const ok = await wiring.sendStreamingChunk('tg:123', 'chunk', {
      threadId: 'thread-1',
    });

    expect(ok).toBe(true);
    expect(streamSink).toHaveBeenCalledWith(
      'tg:123',
      'chunk',
      expect.objectContaining({ threadId: 'thread-1' }),
    );
    expect(storeMessage).not.toHaveBeenCalled();
  });

  it('flushes done=true streaming callbacks even when visible text is empty', async () => {
    const app = makeApp();
    const streamSink = vi.fn(async () => true);
    const outbound = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'tg:123'),
      sendStreamingChunk: streamSink,
    });

    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'telegram',
          vi.fn(() => outbound),
        ),
      ],
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
    );

    const ok = await wiring.sendStreamingChunk(
      'tg:123',
      '<internal>only-internal</internal>',
      { done: true },
    );

    expect(ok).toBe(true);
    expect(streamSink).toHaveBeenCalledWith(
      'tg:123',
      '',
      expect.objectContaining({ done: true }),
    );
  });

  it('routes permission approvals through main groups and falls back safely', async () => {
    const app = makeApp({
      'tg:main': { name: 'Main', folder: 'main', isMain: true },
      'tg:other': { name: 'Other', folder: 'other' },
    });

    const approvalChannel = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'tg:main'),
      requestPermissionApproval: vi.fn(async () => ({ approved: true })),
    });
    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'telegram',
          vi.fn(() => approvalChannel),
        ),
      ],
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
    );
    const result = await wiring.requestPermissionApproval({
      requestId: 'req-1',
      sourceGroup: 'tg:other',
      toolName: 'danger-tool',
    });

    expect(result.approved).toBe(true);

    const fallbackWiring = createChannelWiring(makeApp({}));
    const fallback = await fallbackWiring.requestPermissionApproval({
      requestId: 'req-2',
      sourceGroup: 'tg:none',
      toolName: 'danger-tool',
    });

    expect(fallback).toEqual({
      approved: false,
      reason: 'No main channel supports interactive permission approvals',
    });
  });

  it('routes direct DM permission approvals to the configured DM admin', async () => {
    const app = makeApp({
      'tg:111': { name: 'Alice DM', folder: 'main_agent' },
    });
    const requestPermissionApproval = vi.fn(async () => ({ approved: true }));
    runtimeStoreMock.repositories.conversations.getConversation.mockResolvedValueOnce(
      {
        id: 'conversation:tg:111',
        appId: 'default',
        providerConnectionId: 'telegram_default',
        kind: 'direct',
      },
    );
    runtimeStoreMock.repositories.providerConnections.listAgentConversationBindingsByConversation.mockResolvedValueOnce(
      [
        {
          agentId: 'main_agent',
          conversationId: 'conversation:tg:111',
          providerConnectionId: 'telegram_default',
          status: 'active',
        },
      ],
    );
    runtimeStoreMock.repositories.providerConnections.getProviderConnection.mockResolvedValueOnce(
      {
        id: 'telegram_default',
        appId: 'default',
        providerId: 'telegram',
      },
    );
    runtimeStoreMock.repositories.agents.listAgentDmApprovers.mockResolvedValueOnce(
      [
        {
          agentId: 'main_agent',
          providerId: 'telegram',
          externalUserId: '575',
        },
      ],
    );

    const approvalChannel = makeChannel({
      ownsJid: vi.fn((jid: string) => jid.startsWith('tg:')),
      requestPermissionApproval,
    });
    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'telegram',
          vi.fn(() => approvalChannel),
        ),
      ],
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
    );

    const result = await wiring.requestPermissionApproval({
      requestId: 'req-dm-admin',
      sourceGroup: 'main_agent',
      targetJid: 'tg:111',
      toolName: 'danger-tool',
    });

    expect(result.approved).toBe(true);
    expect(requestPermissionApproval).toHaveBeenCalledWith(
      'tg:575',
      expect.objectContaining({
        targetJid: 'tg:575',
        approvalContextJid: 'tg:111',
      }),
    );
  });

  it('treats settings-style dm conversations as direct approval contexts', async () => {
    const app = makeApp({
      'tg:222': { name: 'Bob DM', folder: 'main_agent' },
    });
    const requestPermissionApproval = vi.fn(async () => ({ approved: true }));
    runtimeStoreMock.repositories.conversations.getConversation.mockResolvedValueOnce(
      {
        id: 'conversation:tg:222',
        appId: 'default',
        providerConnectionId: 'telegram_default',
        kind: 'dm',
      },
    );
    runtimeStoreMock.repositories.providerConnections.listAgentConversationBindingsByConversation
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          agentId: 'main_agent',
          conversationId: 'conversation:tg:222',
          providerConnectionId: 'telegram_default',
          status: 'active',
        },
      ]);
    runtimeStoreMock.repositories.providerConnections.getProviderConnection.mockResolvedValueOnce(
      {
        id: 'telegram_default',
        appId: 'default',
        providerId: 'telegram',
      },
    );
    runtimeStoreMock.repositories.agents.listAgentDmApprovers.mockResolvedValueOnce(
      [
        {
          agentId: 'main_agent',
          providerId: 'telegram',
          externalUserId: '575',
        },
      ],
    );

    const approvalChannel = makeChannel({
      ownsJid: vi.fn((jid: string) => jid.startsWith('tg:')),
      requestPermissionApproval,
    });
    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'telegram',
          vi.fn(() => approvalChannel),
        ),
      ],
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
    );

    const result = await wiring.requestPermissionApproval({
      requestId: 'req-dm-settings-kind',
      sourceGroup: 'main_agent',
      targetJid: 'tg:222',
      toolName: 'danger-tool',
    });

    expect(result.approved).toBe(true);
    expect(requestPermissionApproval).toHaveBeenCalledWith(
      'tg:575',
      expect.objectContaining({
        targetJid: 'tg:575',
        approvalContextJid: 'tg:222',
      }),
    );
  });

  it('authorizes direct DM approval with the agent DM admin before channel allowlists', async () => {
    const app = makeApp({
      'sl:D123': { name: 'Agent One DM', folder: 'agent_one_dm' },
    });
    let isControlApproverAllowed:
      | ((input: {
          providerId: string;
          conversationJid: string;
          userId: string;
          sourceGroup: string;
        }) => Promise<boolean>)
      | undefined;
    runtimeStoreMock.repositories.conversations.getConversation.mockResolvedValue(
      {
        id: 'conversation:sl:D123',
        appId: 'default',
        providerId: 'slack',
        kind: 'direct',
      },
    );
    runtimeStoreMock.repositories.providerConnections.listAgentConversationBindings.mockResolvedValue(
      [
        {
          agentId: 'agent:one',
          conversationId: 'conversation:sl:D123',
          status: 'active',
        },
      ],
    );
    runtimeStoreMock.repositories.agents.listAgentDmApprovers.mockResolvedValue(
      [
        {
          id: 'dm-admin:slack',
          appId: 'default',
          agentId: 'agent:one',
          providerId: 'slack',
          externalUserId: 'UADMIN',
          createdAt: '2026-05-01T00:00:00.000Z',
          updatedAt: '2026-05-01T00:00:00.000Z',
        },
      ],
    );

    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider('slack', (opts: any) => {
          isControlApproverAllowed = opts.isControlApproverAllowed;
          return makeChannel({
            name: 'slack',
            ownsJid: vi.fn((jid: string) => jid.startsWith('sl:')),
          });
        }),
      ],
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: false, slack: true }),
    );

    await expect(
      isControlApproverAllowed?.({
        providerId: 'slack',
        conversationJid: 'sl:D123',
        userId: 'UADMIN',
        sourceGroup: 'sl:D123',
      }),
    ).resolves.toBe(true);
    await expect(
      isControlApproverAllowed?.({
        providerId: 'slack',
        conversationJid: 'sl:D123',
        userId: 'U1',
        sourceGroup: 'sl:D123',
      }),
    ).resolves.toBe(false);
  });

  it('does not use legacy settings control allowlists for conversation approvals', async () => {
    const app = makeApp({
      'sl:C123': { name: 'Team', folder: 'team' },
    });
    let isControlApproverAllowed:
      | ((input: {
          providerId: string;
          conversationJid: string;
          userId: string;
          sourceGroup: string;
        }) => Promise<boolean>)
      | undefined;
    runtimeStoreMock.repositories.conversations.getConversation.mockResolvedValue(
      {
        id: 'conversation:sl:C123',
        appId: 'default',
        providerId: 'slack',
        kind: 'channel',
      },
    );
    runtimeStoreMock.repositories.conversations.listConversationApprovers.mockResolvedValue(
      [],
    );
    const legacyControlAllowed = vi.fn(() => true);

    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider('slack', (opts: any) => {
          isControlApproverAllowed = opts.isControlApproverAllowed;
          return makeChannel({
            name: 'slack',
            ownsJid: vi.fn((jid: string) => jid.startsWith('sl:')),
          });
        }),
      ],
      loadSenderControlAllowlist: vi.fn(() => ({}) as any),
      isSenderControlAllowed: legacyControlAllowed,
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: false, slack: true }),
    );

    await expect(
      isControlApproverAllowed?.({
        providerId: 'slack',
        conversationJid: 'sl:C123',
        userId: 'UADMIN',
        sourceGroup: 'team',
      }),
    ).resolves.toBe(false);
    expect(legacyControlAllowed).not.toHaveBeenCalled();
  });

  it('routes targeted user questions to the originating channel', async () => {
    const app = makeApp({
      'tg:main': { name: 'Main', folder: 'main', isMain: true },
      'tg:group': { name: 'Group', folder: 'group' },
    });

    const requestUserAnswer = vi.fn(async () => ({
      requestId: 'q-1',
      answers: { Choice: 'A' },
      answeredBy: '5759865942',
    }));
    const questionChannel = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'tg:group'),
      requestUserAnswer,
    });
    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'telegram',
          vi.fn(() => questionChannel),
        ),
      ],
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
    );

    const response = await wiring.requestUserAnswer({
      requestId: 'q-1',
      sourceGroup: 'group',
      targetJid: 'tg:group',
      questions: [],
    });

    expect(response).toEqual({
      requestId: 'q-1',
      answers: { Choice: 'A' },
      answeredBy: '5759865942',
    });
    expect(requestUserAnswer).toHaveBeenCalledWith(
      'tg:group',
      expect.objectContaining({
        requestId: 'q-1',
        sourceGroup: 'group',
        targetJid: 'tg:group',
      }),
    );
  });

  it('returns empty answers when user-question flow fails', async () => {
    const app = makeApp({
      'tg:main': { name: 'Main', folder: 'main', isMain: true },
    });

    const questionChannel = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'tg:main'),
      requestUserAnswer: vi.fn(async () => {
        throw new Error('request failed');
      }),
    });
    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'telegram',
          vi.fn(() => questionChannel),
        ),
      ],
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      },
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
    );

    const response = await wiring.requestUserAnswer({
      requestId: 'q-1',
      sourceGroup: 'tg:main',
      questions: [],
    });

    expect(response).toEqual({ requestId: 'q-1', answers: {} });
  });
});

describe('createChannelPersistenceHandlers agent DM access', () => {
  it('registers an unregistered direct conversation for the single allowed agent', async () => {
    const registeredGroups: Record<string, any> = {};
    const app = makeApp(registeredGroups);
    const storeMessage = vi.fn(async () => undefined);
    runtimeStoreMock.repositories.agents.findAgentsByDmAccess.mockResolvedValueOnce(
      [
        {
          id: 'agent:one',
          appId: 'default',
          name: 'Agent One',
          status: 'active',
          createdAt: '2026-05-01T00:00:00.000Z',
          updatedAt: '2026-05-01T00:00:00.000Z',
        },
      ],
    );

    const handlers = createChannelPersistenceHandlers({
      app,
      resolved: {
        providerIds: [],
        loadSenderAllowlist: vi.fn(() => ({}) as any),
        loadSenderControlAllowlist: vi.fn(() => ({}) as any),
        shouldDropMessage: vi.fn(() => false),
        isSenderAllowed: vi.fn(() => true),
        isSenderControlAllowed: vi.fn(() => true),
        shouldLogDenied: vi.fn(() => false),
        asRemoteControlCommand: vi.fn(() => null),
        handleRemoteControlCommand: vi.fn(async () => {}),
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          debug: vi.fn(),
          error: vi.fn(),
        },
        opsRepository: { storeMessage } as any,
      },
      ops: () => ({ storeMessage, storeChatMetadata: vi.fn() }) as any,
      findBoundChannel: vi.fn(),
      persistenceQueue: new AsyncTaskQueue(4, 5_000),
      ...dmAccessTestDeps(),
    });

    await handlers.onChatMetadata(
      'sl:D123',
      '2026-05-01T00:00:00.000Z',
      'User',
      'slack',
      false,
    );
    const msg = {
      id: 'm1',
      chat_jid: 'sl:D123',
      provider: 'slack',
      sender: 'U123',
      sender_name: 'User',
      content: 'hello',
      timestamp: '2026-05-01T00:00:01.000Z',
    };
    await handlers.onMessage('sl:D123', msg);

    expect(app.registerGroup).toHaveBeenCalledWith(
      'sl:D123',
      expect.objectContaining({
        name: 'Agent One DM',
        requiresTrigger: false,
      }),
    );
    expect(
      runtimeStoreMock.repositories.providerConnections
        .saveAgentConversationBinding,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: 'agent:one',
        providerConnectionId: 'channel-providerConnection:default:slack',
        conversationId: 'conversation:sl:D123',
        triggerMode: 'always',
      }),
    );
    expect(storeMessage).toHaveBeenCalledWith(msg);
  });

  it('uses a distinct runtime folder for each allowed direct conversation', async () => {
    const registeredGroups: Record<string, any> = {};
    const app = makeApp(registeredGroups);
    const storeMessage = vi.fn(async () => undefined);
    runtimeStoreMock.repositories.agents.findAgentsByDmAccess.mockResolvedValue(
      [
        {
          id: 'agent:one',
          appId: 'default',
          name: 'Agent One',
          status: 'active',
          createdAt: '2026-05-01T00:00:00.000Z',
          updatedAt: '2026-05-01T00:00:00.000Z',
        },
      ],
    );

    const handlers = createChannelPersistenceHandlers({
      app,
      resolved: {
        providerIds: [],
        loadSenderAllowlist: vi.fn(() => ({}) as any),
        loadSenderControlAllowlist: vi.fn(() => ({}) as any),
        shouldDropMessage: vi.fn(() => false),
        isSenderAllowed: vi.fn(() => true),
        isSenderControlAllowed: vi.fn(() => true),
        shouldLogDenied: vi.fn(() => false),
        asRemoteControlCommand: vi.fn(() => null),
        handleRemoteControlCommand: vi.fn(async () => {}),
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          debug: vi.fn(),
          error: vi.fn(),
        },
        opsRepository: { storeMessage } as any,
      },
      ops: () => ({ storeMessage, storeChatMetadata: vi.fn() }) as any,
      findBoundChannel: vi.fn(),
      persistenceQueue: new AsyncTaskQueue(4, 5_000),
      ...dmAccessTestDeps(),
    });

    await handlers.onChatMetadata(
      'sl:D1',
      '2026-05-01T00:00:00.000Z',
      'A',
      'slack',
      false,
    );
    await handlers.onChatMetadata(
      'sl:D2',
      '2026-05-01T00:00:00.000Z',
      'B',
      'slack',
      false,
    );
    await handlers.onMessage('sl:D1', {
      id: 'm1',
      chat_jid: 'sl:D1',
      provider: 'slack',
      sender: 'U1',
      sender_name: 'A',
      content: 'hello',
      timestamp: '2026-05-01T00:00:01.000Z',
    });
    await handlers.onMessage('sl:D2', {
      id: 'm2',
      chat_jid: 'sl:D2',
      provider: 'slack',
      sender: 'U2',
      sender_name: 'B',
      content: 'hello',
      timestamp: '2026-05-01T00:00:02.000Z',
    });

    expect(registeredGroups['sl:D1']?.folder).toMatch(/^dm_slack_/);
    expect(registeredGroups['sl:D2']?.folder).toMatch(/^dm_slack_/);
    expect(registeredGroups['sl:D1']?.folder).not.toBe(
      registeredGroups['sl:D2']?.folder,
    );
  });

  it('drops registered direct conversations after DM access is revoked', async () => {
    const registeredGroups: Record<string, any> = {
      'sl:D123': {
        name: 'Agent One DM',
        folder: 'dm_slack_previous',
        trigger: '@Agent One',
        added_at: '2026-05-01T00:00:00.000Z',
        requiresTrigger: false,
      },
    };
    const app = makeApp(registeredGroups);
    const storeMessage = vi.fn(async () => undefined);
    runtimeStoreMock.repositories.agents.findAgentsByDmAccess.mockReset();
    runtimeStoreMock.repositories.agents.findAgentsByDmAccess.mockResolvedValue(
      [],
    );

    const handlers = createChannelPersistenceHandlers({
      app,
      resolved: {
        providerIds: [],
        loadSenderAllowlist: vi.fn(() => ({}) as any),
        loadSenderControlAllowlist: vi.fn(() => ({}) as any),
        shouldDropMessage: vi.fn(() => false),
        isSenderAllowed: vi.fn(() => true),
        isSenderControlAllowed: vi.fn(() => true),
        shouldLogDenied: vi.fn(() => false),
        asRemoteControlCommand: vi.fn(() => null),
        handleRemoteControlCommand: vi.fn(async () => {}),
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          debug: vi.fn(),
          error: vi.fn(),
        },
        opsRepository: { storeMessage } as any,
      },
      ops: () => ({ storeMessage, storeChatMetadata: vi.fn() }) as any,
      findBoundChannel: vi.fn(),
      persistenceQueue: new AsyncTaskQueue(4, 5_000),
      ...dmAccessTestDeps(),
    });

    await handlers.onMessage('sl:D123', {
      id: 'm-revoked',
      chat_jid: 'sl:D123',
      provider: 'slack',
      sender: 'U123',
      sender_name: 'User',
      content: 'still here',
      timestamp: '2026-05-01T00:00:01.000Z',
    });

    expect(storeMessage).not.toHaveBeenCalled();
  });

  it('does not register unregistered group conversations through DM access', async () => {
    const app = makeApp({});
    const storeMessage = vi.fn(async () => undefined);
    runtimeStoreMock.repositories.agents.findAgentsByDmAccess.mockClear();

    const handlers = createChannelPersistenceHandlers({
      app,
      resolved: {
        providerIds: [],
        loadSenderAllowlist: vi.fn(() => ({}) as any),
        loadSenderControlAllowlist: vi.fn(() => ({}) as any),
        shouldDropMessage: vi.fn(() => false),
        isSenderAllowed: vi.fn(() => true),
        isSenderControlAllowed: vi.fn(() => true),
        shouldLogDenied: vi.fn(() => false),
        asRemoteControlCommand: vi.fn(() => null),
        handleRemoteControlCommand: vi.fn(async () => {}),
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          debug: vi.fn(),
          error: vi.fn(),
        },
        opsRepository: { storeMessage } as any,
      },
      ops: () => ({ storeMessage, storeChatMetadata: vi.fn() }) as any,
      findBoundChannel: vi.fn(),
      persistenceQueue: new AsyncTaskQueue(4, 5_000),
      ...dmAccessTestDeps(),
    });

    await handlers.onChatMetadata(
      'sl:C123',
      '2026-05-01T00:00:00.000Z',
      'Channel',
      'slack',
      true,
    );
    await handlers.onMessage('sl:C123', {
      id: 'm2',
      chat_jid: 'sl:C123',
      provider: 'slack',
      sender: 'U123',
      sender_name: 'User',
      content: 'hello',
      timestamp: '2026-05-01T00:00:01.000Z',
    });

    expect(app.registerGroup).not.toHaveBeenCalled();
    expect(
      runtimeStoreMock.repositories.agents.findAgentsByDmAccess,
    ).not.toHaveBeenCalled();
    expect(storeMessage).not.toHaveBeenCalled();
  });

  it('drops unregistered direct conversations when DM access is ambiguous', async () => {
    const app = makeApp({});
    const storeMessage = vi.fn(async () => undefined);
    runtimeStoreMock.repositories.providerConnections.saveAgentConversationBinding.mockClear();
    runtimeStoreMock.repositories.agents.findAgentsByDmAccess.mockResolvedValueOnce(
      [
        {
          id: 'agent:one',
          appId: 'default',
          name: 'Agent One',
          status: 'active',
          createdAt: '2026-05-01T00:00:00.000Z',
          updatedAt: '2026-05-01T00:00:00.000Z',
        },
        {
          id: 'agent:two',
          appId: 'default',
          name: 'Agent Two',
          status: 'active',
          createdAt: '2026-05-01T00:00:00.000Z',
          updatedAt: '2026-05-01T00:00:00.000Z',
        },
      ],
    );

    const handlers = createChannelPersistenceHandlers({
      app,
      resolved: {
        providerIds: [],
        loadSenderAllowlist: vi.fn(() => ({}) as any),
        loadSenderControlAllowlist: vi.fn(() => ({}) as any),
        shouldDropMessage: vi.fn(() => false),
        isSenderAllowed: vi.fn(() => true),
        isSenderControlAllowed: vi.fn(() => true),
        shouldLogDenied: vi.fn(() => false),
        asRemoteControlCommand: vi.fn(() => null),
        handleRemoteControlCommand: vi.fn(async () => {}),
        logger: {
          info: vi.fn(),
          warn: vi.fn(),
          debug: vi.fn(),
          error: vi.fn(),
        },
        opsRepository: { storeMessage } as any,
      },
      ops: () => ({ storeMessage, storeChatMetadata: vi.fn() }) as any,
      findBoundChannel: vi.fn(),
      persistenceQueue: new AsyncTaskQueue(4, 5_000),
      ...dmAccessTestDeps(),
    });

    await handlers.onChatMetadata(
      'sl:D999',
      '2026-05-01T00:00:00.000Z',
      'User',
      'slack',
      false,
    );
    await handlers.onMessage('sl:D999', {
      id: 'm3',
      chat_jid: 'sl:D999',
      provider: 'slack',
      sender: 'U999',
      sender_name: 'User',
      content: 'hello',
      timestamp: '2026-05-01T00:00:01.000Z',
    });

    expect(
      runtimeStoreMock.repositories.agents.findAgentsByDmAccess,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'slack',
        externalUserId: 'U999',
      }),
    );
    expect(app.registerGroup).not.toHaveBeenCalled();
    expect(
      runtimeStoreMock.repositories.providerConnections
        .saveAgentConversationBinding,
    ).not.toHaveBeenCalled();
    expect(storeMessage).not.toHaveBeenCalled();
  });
});
