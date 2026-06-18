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
    agents: {},
    providerConnections: {
      getProviderConnection: vi.fn(async () => null),
      saveAgentConversationBinding: vi.fn(async () => undefined),
      listAgentConversationBindings: vi.fn(async () => []),
      listAgentConversationBindingsByConversation: vi.fn(async () => []),
    },
    conversations: {
      getConversation: vi.fn(async () => null),
      listConversationApprovers: vi.fn(async () => []),
      listParticipantExternalUserIds: vi.fn(async () => []),
    },
  },
}));
const runtimeLeaseMock = vi.hoisted(() => ({
  tryAcquire: vi.fn(async () => ({
    onLost: vi.fn(),
    release: vi.fn(async () => undefined),
  })),
}));

vi.mock('@core/adapters/storage/postgres/runtime-store.js', () => ({
  getRuntimeStorage: () => ({ repositories: runtimeStoreMock.repositories }),
  getRuntimeRepositories: () => runtimeStoreMock.opsRepository,
  tryAcquireRuntimeAdvisoryLease: runtimeLeaseMock.tryAcquire,
}));

import { RuntimeSettings } from '@core/config/settings/runtime-settings.js';
import { ChannelAdapter } from '@core/channels/channel-provider.js';
import { Provider } from '@core/channels/provider-registry.js';
import { AsyncTaskQueue } from '@core/app/bootstrap/async-task-queue.js';
import { createChannelPersistenceHandlers } from '@core/app/bootstrap/channel-persistence-handlers.js';
import { createChannelWiring } from '@core/app/bootstrap/channel-wiring.js';
import { createPermissionApprovalRequester } from '@core/app/bootstrap/channel-wiring-interactions.js';
import { PERMISSION_APPROVAL_TIMEOUT_MS } from '@core/config/index.js';
import { RuntimeApp } from '@core/app/bootstrap/runtime-app.js';
import { PartialMessageDeliveryError } from '@core/domain/messages/partial-delivery.js';
import { AmbiguousDurableDeliveryError } from '@core/domain/messages/durable-delivery.js';

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
        model: 'text-embedding-3-small',
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
    runtime: {
      queue: {
        maxMessageRuns: 3,
        maxJobRuns: 4,
        maxRetries: 5,
        baseRetryMs: 5000,
      },
      liveTurns: {
        enabled: true,
        hostLeaseTtlMs: 30_000,
        hostLeaseRenewMs: 10_000,
        heartbeatMs: 10_000,
        leaseTtlMs: 30_000,
        maxRunMs: 3_600_000,
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

function makeApp(conversationRoutes: Record<string, any> = {}): RuntimeApp {
  return {
    queue: {} as RuntimeApp['queue'],
    loadState: vi.fn(),
    saveState: vi.fn(),
    getOrRecoverCursor: vi.fn(),
    registerGroup: vi.fn(async (jid: string, group: any) => {
      conversationRoutes[jid] = group;
    }),
    projectConversationRoute: vi.fn(async (jid: string, group: any) => {
      conversationRoutes[jid] = group;
    }),
    unregisterConversationRoute: vi.fn(async (jid: string) => {
      delete conversationRoutes[jid];
    }),
    setGroupModelOverride: vi.fn(),
    setGroupThinkingOverride: vi.fn(),
    getAvailableGroups: vi.fn(() => []),
    setConversationRoutesForTest: vi.fn(),
    ensureCredentialBindingsForConversationRoutes: vi.fn(),
    processGroupMessages: vi.fn(),
    getConversationRoutes: vi.fn(() => conversationRoutes),
    getLastTimestamp: vi.fn(() => ''),
    setLastTimestamp: vi.fn(),
    setAgentCursor: vi.fn(),
    setChannelRuntime: vi.fn(),
  };
}

function makeProvider(
  id: Provider['id'],
  create: Provider['create'],
  overrides: Partial<Provider> = {},
): Provider {
  return {
    id,
    label: id,
    jidPrefix: id === 'telegram' ? 'tg:' : 'sl:',
    folderPrefix: `${id}_`,
    isGroupJid: (jid: string) =>
      id === 'telegram' ? jid.startsWith('tg:-') : jid.startsWith('sl:'),
    canStreamToJid:
      id === 'telegram' ? (jid: string) => jid.startsWith('tg:-') : undefined,
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
    ...overrides,
  };
}

describe('createChannelWiring', () => {
  it('writes a host-side timeout denial when a channel approval surface wedges', async () => {
    vi.useFakeTimers();
    try {
      const requestPermissionApproval = createPermissionApprovalRequester({
        findBoundChannel: () => ({}),
        asPermissionApprovalSurface: () => ({
          requestPermissionApproval: vi.fn(() => new Promise(() => undefined)),
        }),
        logger: { error: vi.fn() },
      });

      const decisionPromise = requestPermissionApproval({
        requestId: 'perm-1',
        sourceAgentFolder: 'team',
        targetJid: 'tg:team',
        toolName: 'Bash',
        toolInput: { command: 'npm test' },
      });
      await vi.advanceTimersByTimeAsync(PERMISSION_APPROVAL_TIMEOUT_MS);

      await expect(decisionPromise).resolves.toMatchObject({
        approved: false,
        decidedBy: 'system',
        decisionClassification: 'user_reject',
        reason: expect.stringContaining('No approval received within 5 min'),
      });
    } finally {
      vi.useRealTimers();
    }
  });

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

  it('connects channels without inbound messages or callbacks when live turns are disabled', async () => {
    const app = makeApp();
    const channel = makeChannel();
    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'telegram',
          vi.fn(() => channel),
        ),
      ],
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      },
    });
    const settings = makeRuntimeSettings({ telegram: true, slack: false });
    settings.runtime.liveTurns.enabled = false;

    await wiring.connectEnabledChannels(settings);

    expect(channel.connect).toHaveBeenCalledWith({
      inbound: false,
      interactionCallbacks: false,
    });
  });

  it('connects outbound-only when the process role has no provider inbound', async () => {
    const app = makeApp();
    const channel = makeChannel();
    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'telegram',
          vi.fn(() => channel),
        ),
      ],
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      },
    });
    // Live turns enabled globally, but the role (control/job-worker) forbids
    // inbound: channels still connect, but outbound-only.
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
      { providerInbound: false },
    );

    expect(channel.connect).toHaveBeenCalledWith({
      inbound: false,
      interactionCallbacks: false,
    });
  });

  it('connects with inbound when the role admits provider inbound', async () => {
    const app = makeApp();
    const channel = makeChannel();
    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'telegram',
          vi.fn(() => channel),
        ),
      ],
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
      { providerInbound: true },
    );

    expect(channel.connect).toHaveBeenCalledWith({
      inbound: true,
      interactionCallbacks: true,
    });
  });

  it('uses a singleton provider inbound lease in fleet mode', async () => {
    runtimeLeaseMock.tryAcquire.mockClear();
    const app = makeApp();
    const channel = makeChannel();
    const lease = {
      onLost: vi.fn(),
      release: vi.fn(async () => undefined),
    };
    runtimeLeaseMock.tryAcquire.mockResolvedValueOnce(lease);
    const settings = makeRuntimeSettings({ telegram: true, slack: false });
    settings.runtime.deploymentMode = 'fleet';
    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'telegram',
          vi.fn(() => channel),
        ),
      ],
    });

    await wiring.connectEnabledChannels(settings, { providerInbound: true });

    expect(runtimeLeaseMock.tryAcquire).toHaveBeenCalledWith(
      'runtime:provider-inbound:telegram:default',
    );
    expect(channel.connect).toHaveBeenCalledWith({
      inbound: true,
      interactionCallbacks: true,
    });
    expect(lease.onLost).toHaveBeenCalledOnce();
  });

  it('connects fleet channels outbound-only when another worker owns provider inbound', async () => {
    runtimeLeaseMock.tryAcquire.mockClear();
    runtimeLeaseMock.tryAcquire.mockResolvedValueOnce(undefined);
    const app = makeApp();
    const channel = makeChannel();
    const settings = makeRuntimeSettings({ telegram: true, slack: false });
    settings.runtime.deploymentMode = 'fleet';
    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'telegram',
          vi.fn(() => channel),
        ),
      ],
    });

    await wiring.connectEnabledChannels(settings, { providerInbound: true });

    expect(channel.connect).toHaveBeenCalledWith({
      inbound: false,
      interactionCallbacks: false,
    });
  });

  it('fails clearly when an enabled provider has only setup/discovery support', async () => {
    const app = makeApp();
    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'telegram',
          vi.fn(() => null),
          {
            label: 'Teams',
            controlCapabilityFlags: [
              'setup',
              'discover',
              'runtime-placeholder',
            ],
          },
        ),
      ],
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      },
    });

    await expect(
      wiring.connectEnabledChannels(
        makeRuntimeSettings({ telegram: true, slack: false }),
      ),
    ).rejects.toThrow(/runtime transport is not implemented/);
  });

  it('drops disallowed inbound sender before persistence', async () => {
    const app = makeApp({
      'tg:123': { name: 'Main', folder: 'main' },
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

  it('stores normal inbound messages', async () => {
    const app = makeApp({
      'tg:123': { name: 'Main', folder: 'main' },
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

  it('stores inbound messages with durable live admission when supported', async () => {
    const app = makeApp({
      'tg:123': {
        name: 'Main',
        folder: 'main_agent',
        trigger: '@Main',
        added_at: '2026-01-01T00:00:00.000Z',
        requiresTrigger: false,
        conversationKind: 'channel',
      },
    });
    const storeMessage = vi.fn(async () => {});
    const storeMessageWithLiveAdmission = vi.fn(async () => undefined);
    let onMessage: ((chatJid: string, msg: any) => Promise<void>) | undefined;

    const wiring = createChannelWiring(app, {
      appId: 'app-one' as never,
      providerIds: [
        makeProvider('telegram', (opts: any) => {
          onMessage = opts.onMessage;
          return makeChannel();
        }),
      ],
      opsRepository: {
        storeMessage,
        storeMessageWithLiveAdmission,
      } as any,
      shouldDropMessage: vi.fn(() => false),
    });

    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
    );

    const msg = {
      id: 'm-live-admission',
      chat_jid: 'tg:123',
      sender: 'user-1',
      sender_name: 'User',
      content: 'normal message',
      timestamp: '2026-01-01T00:00:00.000Z',
    };

    await onMessage?.('tg:123', msg);

    expect(storeMessage).not.toHaveBeenCalled();
    expect(storeMessageWithLiveAdmission).toHaveBeenCalledWith(msg, {
      appId: 'app-one',
      agentId: 'main_agent',
      triggerDecision: {
        source: 'channel_persistence',
        requiresTrigger: false,
        conversationKind: 'channel',
      },
    });
  });

  it('waits for queue capacity when message persistence queue is full', async () => {
    const app = makeApp({
      'tg:123': { name: 'Main', folder: 'main' },
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

    await wiring.sendMessage('tg:123', '**done**', {
      durability: 'best_effort',
    });
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
      durability: 'best_effort',
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

  it('publishes provider-neutral outbound conversation message events', async () => {
    const app = makeApp();
    const publishRuntimeEvent = vi.fn(async () => undefined);
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
      publishRuntimeEvent,
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: false, slack: true }),
    );

    await wiring.sendMessage('sl:C123', 'done', {
      durability: 'best_effort',
      messageOptions: { threadId: '1700.1' },
    });

    expect(publishRuntimeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'default',
        conversationId: 'sl:C123',
        threadId: '1700.1',
        eventType: 'conversation.message.outbound',
        actor: 'agent',
        responseMode: 'none',
        payload: expect.objectContaining({
          conversationId: 'conversation:sl:C123',
          threadId: 'thread:sl:C123:1700.1',
          direction: 'outbound',
          deliveryStatus: 'sent',
          externalMessageId: '171.123',
          sender: { id: 'gantry', name: 'Gantry' },
          text: 'done',
        }),
      }),
    );
  });

  it('requires a channel-minted recovery permit for provider-level recovery sends', async () => {
    const app = makeApp();
    const outbound = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'sl:C123'),
    });
    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'slack',
          vi.fn(() => outbound),
        ),
      ],
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: false, slack: true }),
    );

    await expect(
      wiring.sendProviderMessage('sl:C123', 'Recovered outbound', {
        permit: {
          deliveryId: 'delivery:1',
          itemId: 'delivery-item:1',
          destinationJid: 'sl:C123',
          canonicalText: 'Recovered outbound',
        } as any,
      }),
    ).rejects.toThrow(/recovery dispatch permit/);
    expect(outbound.sendMessage).not.toHaveBeenCalled();
  });

  it('allows provider-level recovery sends only when permit scope matches destination payload', async () => {
    const app = makeApp();
    const storeMessage = vi.fn(async () => undefined);
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

    const permit = wiring.createRecoveryDispatchPermit({
      deliveryId: 'delivery:1',
      itemId: 'delivery-item:1',
      destinationJid: 'sl:C123',
      canonicalText: 'Recovered outbound',
      threadId: '171.000',
    });
    await wiring.sendProviderMessage('sl:C123', 'Recovered outbound', {
      permit,
      messageOptions: { threadId: '171.000' },
      throwOnMissing: true,
    });

    expect(outbound.sendMessage).toHaveBeenCalledWith(
      'sl:C123',
      'Recovered outbound',
      { threadId: '171.000' },
    );
    expect(storeMessage).not.toHaveBeenCalled();
  });

  it('fails closed before provider send when durable outbound delivery storage is unavailable', async () => {
    const app = makeApp();
    const outbound = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'sl:C123'),
    });

    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'slack',
          vi.fn(() => outbound),
        ),
      ],
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: false, slack: true }),
    );

    await expect(
      wiring.sendMessage('sl:C123', 'durable', { durability: 'required' }),
    ).rejects.toThrow(/Durable outbound delivery is required/);
    expect(outbound.sendMessage).not.toHaveBeenCalled();
  });

  it('continues provider send when best-effort pending persistence fails', async () => {
    const app = makeApp();
    const storeMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error('db offline'))
      .mockResolvedValueOnce(undefined);
    const outbound = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'sl:C123'),
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

    await expect(
      wiring.sendMessage('sl:C123', 'best-effort', {
        durability: 'best_effort',
      }),
    ).resolves.toBeUndefined();
    expect(outbound.sendMessage).toHaveBeenCalledWith('sl:C123', 'best-effort');
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

    await expect(
      wiring.sendMessage('sl:C123', 'done', { durability: 'best_effort' }),
    ).rejects.toThrow(providerErr);

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

  it('persists retry-tail metadata durably for partial live sends before bubbling the partial error', async () => {
    const app = makeApp();
    const storeMessage = vi.fn().mockResolvedValue(undefined);
    const settlePartiallyDelivered = vi.fn(async () => undefined);
    const partial = new PartialMessageDeliveryError({
      cause: new Error('second chunk failed'),
      deliveredChunks: 1,
      totalChunks: 2,
      name: 'PartialSlackDeliveryError',
      message: 'first chunk visible',
    });
    Object.assign(partial, {
      provider: 'slack',
      deliveredParts: 1,
      totalParts: 2,
      retryTail: {
        canonicalText: 'unsent suffix',
        providerPayload: {
          provider: 'slack',
          channelId: 'CWRONG',
          threadId: 'thread-1',
        },
      },
    });
    const outbound = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'sl:C123'),
      sendMessage: vi.fn(async () => {
        throw partial;
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
        error: vi.fn(),
      },
      opsRepository: { storeMessage } as any,
    });
    wiring.setDurableOutboundAttemptFactory(
      vi.fn(async () => ({
        settleSent: vi.fn(async () => undefined),
        settleFailed: vi.fn(async () => undefined),
        settlePartiallyDelivered,
      })),
    );
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: false, slack: true }),
    );

    await expect(
      wiring.sendMessage('sl:C123', 'done', {
        durability: 'required',
        messageOptions: { threadId: 'thread-1' },
      }),
    ).rejects.toThrow(partial);

    expect(storeMessage).toHaveBeenCalledTimes(2);
    expect(storeMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        chat_jid: 'sl:C123',
        delivery_status: 'partially_sent',
        delivery_retry_tail: {
          canonicalText: 'unsent suffix',
          providerPayload: { provider: 'slack', threadId: 'thread-1' },
        },
      }),
    );
    expect(settlePartiallyDelivered).toHaveBeenCalledWith(
      expect.objectContaining({
        retryTail: {
          canonicalText: 'unsent suffix',
          providerPayload: { provider: 'slack', threadId: 'thread-1' },
        },
      }),
    );
  });

  it('omits mismatched Telegram chatId retry-tail metadata before durable and message-row partial persistence', async () => {
    const app = makeApp();
    const storeMessage = vi.fn().mockResolvedValue(undefined);
    const settlePartiallyDelivered = vi.fn(async () => undefined);
    const partial = new PartialMessageDeliveryError({
      cause: new Error('second chunk failed'),
      deliveredChunks: 1,
      totalChunks: 2,
      name: 'PartialTelegramDeliveryError',
      message: 'first chunk visible',
    });
    Object.assign(partial, {
      provider: 'telegram',
      deliveredParts: 1,
      totalParts: 2,
      retryTail: {
        canonicalText: 'unsent suffix',
        providerPayload: {
          provider: 'telegram',
          chatId: 'tg:-100999',
          threadId: '42',
        },
      },
    });
    const outbound = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'tg:-100123'),
      sendMessage: vi.fn(async () => {
        throw partial;
      }),
    });
    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'telegram',
          vi.fn(() => outbound),
        ),
      ],
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      },
      opsRepository: { storeMessage } as any,
    });
    wiring.setDurableOutboundAttemptFactory(
      vi.fn(async () => ({
        settleSent: vi.fn(async () => undefined),
        settleFailed: vi.fn(async () => undefined),
        settlePartiallyDelivered,
      })),
    );
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
    );

    await expect(
      wiring.sendMessage('tg:-100123', 'done', {
        durability: 'required',
        messageOptions: { threadId: '42' },
      }),
    ).rejects.toThrow(partial);

    expect(storeMessage).toHaveBeenCalledTimes(2);
    expect(storeMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        chat_jid: 'tg:-100123',
        delivery_status: 'partially_sent',
        delivery_retry_tail: {
          canonicalText: 'unsent suffix',
          providerPayload: { provider: 'telegram', threadId: '42' },
        },
      }),
    );
    expect(settlePartiallyDelivered).toHaveBeenCalledWith(
      expect.objectContaining({
        retryTail: {
          canonicalText: 'unsent suffix',
          providerPayload: { provider: 'telegram', threadId: '42' },
        },
      }),
    );
  });

  it('surfaces ambiguous durable state when durable sent settlement fails after visible send', async () => {
    const app = makeApp();
    const storeMessage = vi.fn().mockResolvedValueOnce(undefined);
    const settleSent = vi
      .fn()
      .mockRejectedValueOnce(new Error('sent status write failed'));
    const settlePartiallyDelivered = vi.fn(async () => undefined);
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
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      },
      opsRepository: { storeMessage } as any,
    });
    wiring.setDurableOutboundAttemptFactory(
      vi.fn(async () => ({
        settleSent,
        settleFailed: vi.fn(async () => undefined),
        settlePartiallyDelivered,
      })),
    );
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: false, slack: true }),
    );

    await expect(
      wiring.sendMessage('sl:C123', 'done', { durability: 'required' }),
    ).rejects.toBeInstanceOf(AmbiguousDurableDeliveryError);

    expect(outbound.sendMessage).toHaveBeenCalledTimes(1);
    expect(settleSent).toHaveBeenCalledWith(
      expect.objectContaining({
        providerMessageId: '171.123',
      }),
    );
    expect(settlePartiallyDelivered).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.stringContaining('cannot be blindly retried'),
      }),
    );
    expect(storeMessage).toHaveBeenCalledTimes(1);
  });

  it('raises ambiguous outcome when partial retry-tail durable settlement cannot be persisted', async () => {
    const app = makeApp();
    const storeMessage = vi.fn().mockResolvedValue(undefined);
    const partial = new PartialMessageDeliveryError({
      cause: new Error('second chunk failed'),
      deliveredChunks: 1,
      totalChunks: 2,
      name: 'PartialSlackDeliveryError',
      message: 'first chunk visible',
    });
    Object.assign(partial, {
      provider: 'slack',
      deliveredParts: 1,
      totalParts: 2,
      retryTail: {
        canonicalText: 'unsent suffix',
        providerPayload: { provider: 'slack', chunk: 2 },
      },
    });
    const outbound = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'sl:C123'),
      sendMessage: vi.fn(async () => {
        throw partial;
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
        error: vi.fn(),
      },
      opsRepository: { storeMessage } as any,
    });
    wiring.setDurableOutboundAttemptFactory(
      vi.fn(async () => ({
        settleSent: vi.fn(async () => undefined),
        settleFailed: vi.fn(async () => undefined),
        settlePartiallyDelivered: vi.fn(async () => {
          throw new Error('durable enqueue unavailable');
        }),
      })),
    );
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: false, slack: true }),
    );

    await expect(
      wiring.sendMessage('sl:C123', 'done', { durability: 'required' }),
    ).rejects.toBeInstanceOf(AmbiguousDurableDeliveryError);
    expect(storeMessage).toHaveBeenCalledTimes(2);
  });

  it('does not fallback to direct provider sends when channel has no streaming sink', async () => {
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

    expect(ok).toBe(false);
    expect(outbound.sendMessage).not.toHaveBeenCalled();
  });

  it('preserves leading and trailing whitespace for streaming chunks', async () => {
    const app = makeApp();
    const outbound = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'sl:D123'),
      sendStreamingChunk: vi.fn(async () => true),
    });

    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'slack',
          vi.fn(() => outbound),
          {
            isGroupJid: () => false,
          },
        ),
      ],
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: false, slack: true }),
    );

    const ok = await wiring.sendStreamingChunk('sl:D123', ' leading ');

    expect(ok).toBe(true);
    expect(outbound.sendStreamingChunk).toHaveBeenCalledWith(
      'sl:D123',
      ' leading ',
      undefined,
    );
  });

  it('advertises supportsStreaming=true when provider streaming sink exists', async () => {
    const app = makeApp();
    const outbound = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'tg:-123'),
      sendStreamingChunk: vi.fn(async () => true),
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

    expect(wiring.supportsStreaming('tg:-123')).toBe(true);
  });

  it('does not advertise Telegram private draft streaming', async () => {
    const app = makeApp();
    const outbound = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'tg:123'),
      sendStreamingChunk: vi.fn(async () => true),
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

    expect(wiring.supportsStreaming('tg:123')).toBe(false);
    const ok = await wiring.sendStreamingChunk('tg:123', 'final text', {
      done: true,
    });
    expect(ok).toBe(false);
    expect(outbound.sendStreamingChunk).not.toHaveBeenCalled();
  });

  it('calls provider streaming sinks for partial chunks', async () => {
    const app = makeApp();
    const streamSink = vi.fn(async () => true);
    const outbound = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'tg:-123'),
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

    const ok = await wiring.sendStreamingChunk('tg:-123', 'chunk', {
      threadId: 'thread-1',
    });

    expect(ok).toBe(true);
    expect(streamSink).toHaveBeenCalledWith('tg:-123', 'chunk', {
      threadId: 'thread-1',
    });
    expect(outbound.sendMessage).not.toHaveBeenCalled();
  });

  it('calls provider streaming sinks for final chunks and returns their delivery result', async () => {
    const app = makeApp();
    const streamSink = vi.fn(async () => true);
    const outbound = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'tg:-123'),
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

    const ok = await wiring.sendStreamingChunk('tg:-123', 'chunk', {
      threadId: 'thread-1',
      done: true,
    });

    expect(ok).toBe(true);
    expect(streamSink).toHaveBeenCalledWith('tg:-123', 'chunk', {
      threadId: 'thread-1',
      done: true,
    });
    expect(outbound.sendMessage).not.toHaveBeenCalled();
  });

  it('preserves done=true streaming callbacks after content stripping', async () => {
    const app = makeApp();
    const streamSink = vi.fn(async () => true);
    const outbound = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'tg:-123'),
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
      'tg:-123',
      '<internal>only-internal</internal>',
      { done: true },
    );

    expect(ok).toBe(true);
    expect(streamSink).toHaveBeenCalledWith('tg:-123', '', { done: true });
    expect(outbound.sendMessage).not.toHaveBeenCalled();
  });

  it('routes permission approvals through the target conversation only', async () => {
    const app = makeApp({
      'tg:other': { name: 'Other', folder: 'other' },
    });

    const approvalChannel = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'tg:other'),
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
      sourceAgentFolder: 'tg:other',
      targetJid: 'tg:other',
      toolName: 'danger-tool',
    });

    expect(result.approved).toBe(true);

    const fallbackWiring = createChannelWiring(makeApp({}));
    const fallback = await fallbackWiring.requestPermissionApproval({
      requestId: 'req-2',
      sourceAgentFolder: 'tg:none',
      toolName: 'danger-tool',
    });

    expect(fallback).toEqual({
      approved: false,
      reason: 'Permission approval target is missing',
    });
  });

  it('keeps prompt surfaces available when inbound callbacks are disabled', async () => {
    const app = makeApp({
      'tg:other': { name: 'Other', folder: 'other' },
    });
    const requestPermissionApproval = vi.fn(async () => ({ approved: true }));
    const requestUserAnswer = vi.fn(async () => ({
      requestId: 'q-outbound-only',
      answers: { Choice: 'A' },
    }));
    const outboundOnlyChannel = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'tg:other'),
      requestPermissionApproval,
      requestUserAnswer,
      supportsInteractionCallbacks: vi.fn(() => false),
    } as Partial<ChannelAdapter> & {
      supportsInteractionCallbacks: () => boolean;
    });
    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'telegram',
          vi.fn(() => outboundOnlyChannel),
        ),
      ],
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
    );

    await expect(
      wiring.requestPermissionApproval({
        requestId: 'req-outbound-only',
        sourceAgentFolder: 'tg:other',
        targetJid: 'tg:other',
        toolName: 'danger-tool',
      }),
    ).resolves.toEqual({ approved: true });
    await expect(
      wiring.requestUserAnswer({
        requestId: 'q-outbound-only',
        sourceAgentFolder: 'tg:other',
        targetJid: 'tg:other',
        questions: [],
      }),
    ).resolves.toEqual({
      requestId: 'q-outbound-only',
      answers: { Choice: 'A' },
    });
    expect(requestPermissionApproval).toHaveBeenCalledOnce();
    expect(requestUserAnswer).toHaveBeenCalledOnce();
  });

  it('routes direct DM permission approvals to the direct conversation', async () => {
    const app = makeApp({
      'tg:111': { name: 'Alice DM', folder: 'main_agent' },
    });
    const requestPermissionApproval = vi.fn(async () => ({ approved: true }));

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
      sourceAgentFolder: 'main_agent',
      targetJid: 'tg:111',
      toolName: 'danger-tool',
    });

    expect(result.approved).toBe(true);
    expect(requestPermissionApproval).toHaveBeenCalledWith(
      'tg:111',
      expect.objectContaining({
        targetJid: 'tg:111',
      }),
    );
  });

  it('treats settings-style dm conversations as direct approval contexts', async () => {
    const app = makeApp({
      'tg:222': { name: 'Bob DM', folder: 'main_agent' },
    });
    const requestPermissionApproval = vi.fn(async () => ({ approved: true }));

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
      sourceAgentFolder: 'main_agent',
      targetJid: 'tg:222',
      toolName: 'danger-tool',
    });

    expect(result.approved).toBe(true);
    expect(requestPermissionApproval).toHaveBeenCalledWith(
      'tg:222',
      expect.objectContaining({
        targetJid: 'tg:222',
      }),
    );
  });

  it('authorizes direct DM approval with conversation control approvers', async () => {
    const app = makeApp({
      'app:D123': { name: 'Agent One DM', folder: 'agent_one_dm' },
    });
    let isControlApproverAllowed:
      | ((input: {
          providerId: string;
          conversationJid: string;
          userId: string;
          sourceAgentFolder: string;
        }) => Promise<boolean>)
      | undefined;
    runtimeStoreMock.repositories.conversations.getConversation.mockResolvedValue(
      {
        id: 'conversation:app:D123',
        appId: 'default',
        providerConnectionId: 'app_default',
        kind: 'direct',
      },
    );
    runtimeStoreMock.repositories.providerConnections.getProviderConnection.mockResolvedValue(
      {
        id: 'app_default',
        appId: 'default',
        providerId: 'app',
      },
    );
    runtimeStoreMock.repositories.conversations.listConversationApprovers.mockResolvedValue(
      [{ externalUserId: 'UADMIN' }],
    );
    runtimeStoreMock.repositories.conversations.listParticipantExternalUserIds.mockResolvedValue(
      ['UADMIN'],
    );

    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider('slack', (opts: any) => {
          isControlApproverAllowed = opts.isControlApproverAllowed;
          return makeChannel({
            name: 'slack',
            ownsJid: vi.fn((jid: string) => jid.startsWith('app:')),
          });
        }),
      ],
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: false, slack: true }),
    );

    await expect(
      isControlApproverAllowed?.({
        providerId: 'app',
        conversationJid: 'app:D123',
        userId: 'UADMIN',
        sourceAgentFolder: 'app:D123',
      }),
    ).resolves.toBe(true);
    await expect(
      isControlApproverAllowed?.({
        providerId: 'app',
        conversationJid: 'app:D123',
        userId: 'U1',
        sourceAgentFolder: 'app:D123',
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
          sourceAgentFolder: string;
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
        sourceAgentFolder: 'team',
      }),
    ).resolves.toBe(false);
    expect(legacyControlAllowed).not.toHaveBeenCalled();
  });

  it('routes targeted user questions to the originating channel', async () => {
    const app = makeApp({
      'tg:main': { name: 'Main', folder: 'main' },
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
      sourceAgentFolder: 'group',
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
        sourceAgentFolder: 'group',
        targetJid: 'tg:group',
      }),
    );
    expect(questionChannel.sendMessage).not.toHaveBeenCalled();
  });

  it('uses provider progress sink when available', async () => {
    const app = makeApp({
      'tg:group': { name: 'Group', folder: 'group' },
    });
    const sendProgressUpdate = vi.fn(async () => undefined);
    const channel = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'tg:group'),
      sendProgressUpdate,
    });
    const wiring = createChannelWiring(app, {
      providerIds: [
        makeProvider(
          'telegram',
          vi.fn(() => channel),
        ),
      ],
    });
    await wiring.connectEnabledChannels(
      makeRuntimeSettings({ telegram: true, slack: false }),
    );

    expect(wiring.supportsProgress('tg:group')).toBe(true);
    await wiring.sendProgressUpdate('tg:group', 'Working on it...', {
      threadId: 'thread-1',
    });

    expect(sendProgressUpdate).toHaveBeenCalledWith(
      'tg:group',
      'Working on it...',
      { threadId: 'thread-1' },
    );
  });

  it('does not emit user-question receipts through progress or direct sends', async () => {
    const app = makeApp({
      'tg:group': { name: 'Group', folder: 'group' },
    });

    const requestUserAnswer = vi.fn(async () => ({
      requestId: 'q-dup',
      answers: { Choice: 'A' },
      answeredBy: 'u-1',
    }));
    const questionChannel = makeChannel({
      ownsJid: vi.fn((jid: string) => jid === 'tg:group'),
      requestUserAnswer,
      sendProgressUpdate: vi.fn(async () => undefined),
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

    const first = await wiring.requestUserAnswer({
      requestId: 'q-dup',
      sourceAgentFolder: 'group',
      targetJid: 'tg:group',
      threadId: 'thread-1',
      questions: [],
    });
    const second = await wiring.requestUserAnswer({
      requestId: 'q-dup',
      sourceAgentFolder: 'group',
      targetJid: 'tg:group',
      threadId: 'thread-1',
      questions: [],
    });

    expect(first).toEqual(second);
    expect(requestUserAnswer).toHaveBeenCalledTimes(1);
    expect(questionChannel.sendProgressUpdate).not.toHaveBeenCalled();
    expect(questionChannel.sendMessage).not.toHaveBeenCalled();
  });

  it('returns empty answers when user-question flow fails', async () => {
    const app = makeApp({
      'tg:main': { name: 'Main', folder: 'main' },
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
      sourceAgentFolder: 'tg:main',
      questions: [],
    });

    expect(response).toEqual({ requestId: 'q-1', answers: {} });
  });
});

describe('createChannelPersistenceHandlers conversation-owned direct routes', () => {
  function makePersistenceHandlers(
    app: RuntimeApp,
    storeMessage = vi.fn(async () => undefined),
  ) {
    return {
      storeMessage,
      handlers: createChannelPersistenceHandlers({
        app,
        resolved: {
          providerIds: [],
          loadSenderAllowlist: vi.fn(() => ({}) as any),
          loadSenderControlAllowlist: vi.fn(() => ({}) as any),
          shouldDropMessage: vi.fn(() => false),
          isSenderAllowed: vi.fn(() => true),
          isSenderControlAllowed: vi.fn(() => true),
          shouldLogDenied: vi.fn(() => false),
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
      }),
    };
  }

  it('drops unregistered direct conversations instead of auto-binding by direct conversation policy', async () => {
    const app = makeApp({});
    const { handlers, storeMessage } = makePersistenceHandlers(app);

    await handlers.onChatMetadata(
      'sl:D123',
      '2026-05-01T00:00:00.000Z',
      'User',
      'slack',
      false,
    );
    await handlers.onMessage('sl:D123', {
      id: 'm1',
      chat_jid: 'sl:D123',
      provider: 'slack',
      sender: 'U123',
      sender_name: 'User',
      content: 'hello',
      timestamp: '2026-05-01T00:00:01.000Z',
    });

    expect(app.registerGroup).not.toHaveBeenCalled();
    expect(storeMessage).not.toHaveBeenCalled();
  });

  it('persists configured direct conversations through the normal route policy', async () => {
    const app = makeApp({
      'sl:D123': {
        name: 'Agent One DM',
        folder: 'agent_one',
        trigger: '@Agent One',
        added_at: '2026-05-01T00:00:00.000Z',
        requiresTrigger: false,
      },
    });
    const { handlers, storeMessage } = makePersistenceHandlers(app);
    const msg = {
      id: 'm-configured',
      chat_jid: 'sl:D123',
      provider: 'slack',
      sender: 'U123',
      sender_name: 'User',
      content: 'hello',
      timestamp: '2026-05-01T00:00:01.000Z',
    };

    await handlers.onMessage('sl:D123', msg);

    expect(storeMessage).toHaveBeenCalledWith(msg);
  });
});
