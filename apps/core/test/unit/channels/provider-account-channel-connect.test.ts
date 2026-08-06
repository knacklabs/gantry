import { describe, expect, it, vi } from 'vitest';

import { connectProviderAccountChannels } from '@core/channels/provider-account-channel-connect.js';
import { InboundMessageDeliveryError } from '@core/channels/channel-provider.js';
import type {
  ChannelAdapter,
  ChannelOpts,
} from '@core/channels/channel-provider.js';
import type { Provider } from '@core/channels/provider-registry.js';

function channel(): ChannelAdapter {
  return {
    name: 'slack',
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    isConnected: vi.fn(() => true),
    ownsJid: vi.fn(() => true),
    sendMessage: vi.fn(async () => undefined),
  };
}

function provider(create: Provider['create'], id = 'slack'): Provider {
  return {
    id,
    label: id,
    jidPrefix: 'sl:',
    folderPrefix: 'slack_',
    isGroupJid: () => true,
    formatting: 'mrkdwn',
    isEnabled: () => true,
    create,
    setup: {
      envKeys: [],
      describe: () => 'Slack',
      run: async () => undefined,
    },
  };
}

function channelOpts(
  onMessage: ChannelOpts['onMessage'] = vi.fn(async () => 'dropped'),
): ChannelOpts {
  return {
    onMessage,
    onChatMetadata: vi.fn(async () => undefined),
    conversationRoutes: () => ({}),
  };
}

async function sharedInboundOnMessage(
  onMessage: ChannelOpts['onMessage'],
): Promise<ChannelOpts['onMessage']> {
  let inboundOnMessage: ChannelOpts['onMessage'] | undefined;
  const create = vi.fn<Provider['create']>(async (opts) => {
    inboundOnMessage ??= opts.onMessage;
    return channel();
  });
  await connectProviderAccountChannels({
    provider: provider(create),
    appId: 'app-one',
    runtimeSettings: {
      providerAccounts: {
        slack_one: {
          provider: 'slack',
          agentId: 'agent:one',
          runtimeSecretRefs: { app_token: 'same', bot_token: 'same-bot' },
        },
        slack_two: {
          provider: 'slack',
          agentId: 'agent:two',
          runtimeSecretRefs: { bot_token: 'same-bot', app_token: 'same' },
        },
      },
      runtime: {},
    },
    channelOpts: channelOpts(onMessage),
    inboundEnabled: true,
    connectedChannels: [],
    connectedChannelLeases: [],
    inboundLeasePrefix: 'runtime:provider-inbound',
    logger: { info: vi.fn(), warn: vi.fn() },
  });
  if (!inboundOnMessage) throw new Error('Expected shared inbound transport');
  return inboundOnMessage;
}

const fanOutMessage = {
  id: 'msg-ownership',
  text: 'hello',
  sender: 'U123',
  timestamp: '2026-07-01T00:00:00.000Z',
};

describe('connectProviderAccountChannels', () => {
  it('exposes the App binding durable lease generation to the adapter', async () => {
    let bindingGeneration: (() => number | undefined) | undefined;
    let generationAtConstruction: number | undefined;
    const activeChannel = channel();
    const create = vi.fn<Provider['create']>(async (opts) => {
      bindingGeneration = opts.liveUxBindingGeneration;
      generationAtConstruction = bindingGeneration?.();
      return activeChannel;
    });
    const lease = {
      generation: 7,
      isValid: vi.fn(() => true),
      release: vi.fn(async () => undefined),
    };
    const tryAcquire = vi.fn(async () => lease);
    const connectedChannelLeases: Parameters<
      typeof connectProviderAccountChannels
    >[0]['connectedChannelLeases'] = [];

    await connectProviderAccountChannels({
      provider: { ...provider(create, 'app'), internal: true },
      appId: 'app-one',
      runtimeSettings: { providerAccounts: {}, runtime: {} },
      channelOpts: { ...channelOpts(), runtimeLease: { tryAcquire } },
      inboundEnabled: true,
      connectedChannels: [],
      connectedChannelLeases,
      inboundLeasePrefix: 'runtime:provider-inbound',
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(tryAcquire).toHaveBeenCalledOnce();
    expect(generationAtConstruction).toBe(7);
    expect(bindingGeneration?.()).toBe(7);
    expect(connectedChannelLeases).toEqual([lease]);
  });

  it('distrusts every account sharing an inbound hydration transport before and after connect', async () => {
    const order: string[] = [];
    const activeChannel = channel();
    const disconnect = activeChannel.disconnect;
    activeChannel.hydrateConversationContext = vi.fn(async () => ({
      providerId: 'slack',
      attempted: true,
      messages: [],
    }));
    vi.mocked(activeChannel.connect).mockImplementation(async () => {
      order.push('connect');
    });
    const distrustHistoryCoverage = vi.fn((accountIds) => {
      order.push(`distrust:${accountIds.join(',')}`);
    });
    const setHistoryCoverageInboundActive = vi.fn();

    const connectedChannels: Parameters<
      typeof connectProviderAccountChannels
    >[0]['connectedChannels'] = [];
    await connectProviderAccountChannels({
      provider: provider(vi.fn(async () => activeChannel)),
      appId: 'app-one',
      runtimeSettings: {
        providerAccounts: {
          slack_one: {
            provider: 'slack',
            agentId: 'agent:one',
            runtimeSecretRefs: { app_token: 'same', bot_token: 'same-bot' },
          },
          slack_two: {
            provider: 'slack',
            agentId: 'agent:two',
            runtimeSecretRefs: { bot_token: 'same-bot', app_token: 'same' },
          },
        },
        runtime: {},
      },
      channelOpts: {
        ...channelOpts(),
        distrustHistoryCoverage,
        setHistoryCoverageInboundActive,
      },
      inboundEnabled: true,
      connectedChannels,
      connectedChannelLeases: [],
      inboundLeasePrefix: 'runtime:provider-inbound',
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(distrustHistoryCoverage).toHaveBeenCalledTimes(4);
    for (const call of distrustHistoryCoverage.mock.calls) {
      expect(call[0]).toEqual(['slack_one', 'slack_two']);
    }
    expect(order).toEqual([
      'distrust:slack_one,slack_two',
      'connect',
      'distrust:slack_one,slack_two',
      'distrust:slack_one,slack_two',
      'connect',
      'distrust:slack_one,slack_two',
    ]);
    expect(setHistoryCoverageInboundActive.mock.calls).toEqual([
      [['slack_one', 'slack_two'], false],
      [['slack_one', 'slack_two'], true],
    ]);

    await connectedChannels[0]!.channel.disconnect();

    expect(setHistoryCoverageInboundActive).toHaveBeenLastCalledWith(
      ['slack_one', 'slack_two'],
      false,
    );
    expect(distrustHistoryCoverage).toHaveBeenCalledTimes(5);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('distrusts history when a history-capable account connects outbound-only', async () => {
    const activeChannel = channel();
    activeChannel.hydrateConversationContext = vi.fn(async () => ({
      providerId: 'slack',
      attempted: true,
      messages: [],
    }));
    const distrustHistoryCoverage = vi.fn();
    const setHistoryCoverageInboundActive = vi.fn();

    await connectProviderAccountChannels({
      provider: provider(vi.fn(async () => activeChannel)),
      appId: 'app-one',
      runtimeSettings: {
        providerAccounts: {
          slack_one: {
            provider: 'slack',
            agentId: 'agent:one',
            runtimeSecretRefs: { app_token: 'app', bot_token: 'bot' },
          },
        },
        runtime: {},
      },
      channelOpts: {
        ...channelOpts(),
        distrustHistoryCoverage,
        setHistoryCoverageInboundActive,
      },
      inboundEnabled: false,
      connectedChannels: [],
      connectedChannelLeases: [],
      inboundLeasePrefix: 'runtime:provider-inbound',
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(activeChannel.connect).toHaveBeenCalledWith({
      inbound: false,
      interactionCallbacks: false,
    });
    expect(distrustHistoryCoverage).toHaveBeenCalledTimes(2);
    expect(distrustHistoryCoverage).toHaveBeenNthCalledWith(1, ['slack_one']);
    expect(distrustHistoryCoverage).toHaveBeenNthCalledWith(2, ['slack_one']);
    expect(setHistoryCoverageInboundActive).not.toHaveBeenCalled();
  });

  it('does not distrust Telegram even if an adapter exposes hydration', async () => {
    const activeChannel = channel();
    activeChannel.hydrateConversationContext = vi.fn(async () => ({
      providerId: 'telegram',
      attempted: true,
      messages: [],
    }));
    const distrustHistoryCoverage = vi.fn();

    await connectProviderAccountChannels({
      provider: provider(
        vi.fn(async () => activeChannel),
        'telegram',
      ),
      appId: 'app-one',
      runtimeSettings: {
        providerAccounts: {
          telegram_one: {
            provider: 'telegram',
            agentId: 'agent:one',
            runtimeSecretRefs: { token: 'same' },
          },
        },
        runtime: {},
      },
      channelOpts: { ...channelOpts(), distrustHistoryCoverage },
      inboundEnabled: true,
      connectedChannels: [],
      connectedChannelLeases: [],
      inboundLeasePrefix: 'runtime:provider-inbound',
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(distrustHistoryCoverage).not.toHaveBeenCalled();
  });

  it('observes lease loss during connect and awaits teardown before failing closed', async () => {
    let releaseConnect!: () => void;
    const connectBarrier = new Promise<void>((resolve) => {
      releaseConnect = resolve;
    });
    let releaseDisconnect!: () => void;
    const disconnectBarrier = new Promise<void>((resolve) => {
      releaseDisconnect = resolve;
    });
    let lostHandler: ((err: Error) => void) | undefined;
    let leaseValid = true;
    const lease = {
      generation: 1,
      isValid: vi.fn(() => leaseValid),
      onLost: vi.fn((handler: (err: Error) => void) => {
        lostHandler = handler;
      }),
      release: vi.fn(async () => undefined),
    };
    const activeChannel = channel();
    vi.mocked(activeChannel.connect).mockImplementation(() => connectBarrier);
    vi.mocked(activeChannel.disconnect).mockImplementation(
      () => disconnectBarrier,
    );
    const connectedChannels: Parameters<
      typeof connectProviderAccountChannels
    >[0]['connectedChannels'] = [];
    const connectedChannelLeases: Parameters<
      typeof connectProviderAccountChannels
    >[0]['connectedChannelLeases'] = [];
    const logger = { info: vi.fn(), warn: vi.fn() };
    const lossError = new Error('inbound lease lost during connect');
    let settled = false;

    const outcomePromise = connectProviderAccountChannels({
      provider: provider(vi.fn(async () => activeChannel)),
      appId: 'app-one',
      runtimeSettings: {
        providerAccounts: {
          slack_one: {
            provider: 'slack',
            agentId: 'agent:one',
            runtimeSecretRefs: { app_token: 'same', bot_token: 'same-bot' },
          },
        },
        runtime: { deploymentMode: 'fleet' },
      },
      channelOpts: {
        ...channelOpts(),
        runtimeLease: { tryAcquire: vi.fn(async () => lease) },
      },
      inboundEnabled: true,
      connectedChannels,
      connectedChannelLeases,
      inboundLeasePrefix: 'runtime:provider-inbound',
      logger,
    }).then(
      () => {
        settled = true;
        return { status: 'resolved' as const };
      },
      (error: unknown) => {
        settled = true;
        return { status: 'rejected' as const, error };
      },
    );

    await vi.waitFor(() =>
      expect(activeChannel.connect).toHaveBeenCalledOnce(),
    );
    leaseValid = false;
    lostHandler?.(lossError);
    releaseConnect();
    await Promise.resolve();
    await Promise.resolve();
    const disconnectCallsBeforeRelease = vi.mocked(activeChannel.disconnect)
      .mock.calls.length;
    const settledBeforeDisconnectRelease = settled;
    releaseDisconnect();
    const outcome = await outcomePromise;

    expect(lease.onLost).toHaveBeenCalledOnce();
    expect(disconnectCallsBeforeRelease).toBe(1);
    expect(settledBeforeDisconnectRelease).toBe(false);
    expect(outcome).toEqual({ status: 'rejected', error: lossError });
    expect(connectedChannels).toEqual([]);
    expect(connectedChannelLeases).toEqual([]);
    expect(lease.release).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: lossError }),
      'Provider Account inbound lease lost; disconnecting channel',
    );
  });

  it('degrades to outbound-only when the lease is already lost before connect', async () => {
    // onLost replays synchronously, so the loss is known before connect. Losing
    // inbound must not also cost the ability to SEND — the account should still
    // connect outbound-only, as it does under ordinary lease contention.
    const lossError = new Error('inbound lease lost before connect');
    const lease = {
      generation: 1,
      isValid: vi.fn(() => false),
      onLost: vi.fn((handler: (err: Error) => void) => {
        handler(lossError);
      }),
      release: vi.fn(async () => undefined),
    };
    const activeChannel = channel();
    vi.mocked(activeChannel.connect).mockImplementation(async () => undefined);
    const connectedChannels: Parameters<
      typeof connectProviderAccountChannels
    >[0]['connectedChannels'] = [];
    const connectedChannelLeases: Parameters<
      typeof connectProviderAccountChannels
    >[0]['connectedChannelLeases'] = [];
    const logger = { info: vi.fn(), warn: vi.fn() };

    await connectProviderAccountChannels({
      provider: provider(vi.fn(async () => activeChannel)),
      appId: 'app-one',
      runtimeSettings: {
        providerAccounts: {
          slack_one: {
            provider: 'slack',
            agentId: 'agent:one',
            runtimeSecretRefs: { app_token: 'same', bot_token: 'same-bot' },
          },
        },
        runtime: { deploymentMode: 'fleet' },
      },
      channelOpts: {
        ...channelOpts(),
        runtimeLease: { tryAcquire: vi.fn(async () => lease) },
      },
      inboundEnabled: true,
      connectedChannels,
      connectedChannelLeases,
      inboundLeasePrefix: 'runtime:provider-inbound',
      logger,
    });

    // Connected, but inbound disabled, and the dead lease released and not retained.
    expect(activeChannel.connect).toHaveBeenCalledOnce();
    expect(vi.mocked(activeChannel.connect).mock.calls[0]![0]).toMatchObject({
      inbound: false,
    });
    expect(connectedChannels).toHaveLength(1);
    expect(connectedChannelLeases).toEqual([]);
    expect(lease.release).toHaveBeenCalledOnce();
    expect(activeChannel.disconnect).not.toHaveBeenCalled();
  });

  it('connects one inbound transport for provider accounts sharing secret refs', async () => {
    const channels = [channel(), channel()];
    const create = vi
      .fn<Provider['create']>()
      .mockResolvedValueOnce(channels[0])
      .mockResolvedValueOnce(channels[1]);

    await connectProviderAccountChannels({
      provider: provider(create),
      appId: 'app-one',
      runtimeSettings: {
        providerAccounts: {
          slack_one: {
            provider: 'slack',
            agentId: 'agent:one',
            runtimeSecretRefs: {
              app_token: 'gantry-secret:SLACK_APP_TOKEN',
              bot_token: 'gantry-secret:SLACK_BOT_TOKEN',
            },
          },
          slack_two: {
            provider: 'slack',
            agentId: 'agent:two',
            runtimeSecretRefs: {
              bot_token: 'gantry-secret:SLACK_BOT_TOKEN',
              app_token: 'gantry-secret:SLACK_APP_TOKEN',
            },
          },
        },
        runtime: {},
      },
      channelOpts: channelOpts(),
      inboundEnabled: true,
      connectedChannels: [],
      connectedChannelLeases: [],
      inboundLeasePrefix: 'runtime:provider-inbound',
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(channels[0].connect).toHaveBeenCalledWith({
      inbound: true,
      interactionCallbacks: true,
    });
    expect(create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ appId: 'app-one' }),
    );
    expect(channels[1].connect).toHaveBeenCalledWith({
      inbound: false,
      interactionCallbacks: false,
    });
  });

  it('fans out shared inbound messages to every matching provider account', async () => {
    let firstOnMessage: ChannelOpts['onMessage'] | undefined;
    const onMessage = vi.fn(async () => 'stored' as const);
    const create = vi.fn<Provider['create']>(async (opts) => {
      firstOnMessage ??= opts.onMessage;
      return channel();
    });

    await connectProviderAccountChannels({
      provider: provider(create),
      appId: 'app-one',
      runtimeSettings: {
        providerAccounts: {
          slack_one: {
            provider: 'slack',
            agentId: 'agent:one',
            runtimeSecretRefs: { app_token: 'same', bot_token: 'same-bot' },
          },
          slack_two: {
            provider: 'slack',
            agentId: 'agent:two',
            runtimeSecretRefs: { bot_token: 'same-bot', app_token: 'same' },
          },
        },
        runtime: {},
      },
      channelOpts: channelOpts(onMessage),
      inboundEnabled: true,
      connectedChannels: [],
      connectedChannelLeases: [],
      inboundLeasePrefix: 'runtime:provider-inbound',
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    await firstOnMessage?.('sl:C123', {
      id: 'msg-1',
      text: 'hello',
      sender: 'U123',
      timestamp: '2026-07-01T00:00:00.000Z',
    });

    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onMessage).toHaveBeenNthCalledWith(
      1,
      'sl:C123',
      expect.objectContaining({
        providerAccountId: 'slack_one',
        agentId: 'agent:one',
      }),
    );
    expect(onMessage).toHaveBeenNthCalledWith(
      2,
      'sl:C123',
      expect.objectContaining({
        providerAccountId: 'slack_two',
        agentId: 'agent:two',
      }),
    );
  });

  it('routes shared-credential deletion scope through one callback', async () => {
    let firstDeletionCallback: ChannelOpts['onMessageAttachmentsDeleted'];
    const onMessageAttachmentsDeleted = vi.fn(async () => undefined);
    const create = vi.fn<Provider['create']>(async (opts) => {
      firstDeletionCallback ??= opts.onMessageAttachmentsDeleted;
      return channel();
    });

    await connectProviderAccountChannels({
      provider: provider(create),
      appId: 'app-one',
      runtimeSettings: {
        providerAccounts: {
          slack_one: {
            provider: 'slack',
            agentId: 'agent:one',
            runtimeSecretRefs: { app_token: 'same', bot_token: 'same-bot' },
          },
          slack_two: {
            provider: 'slack',
            agentId: 'agent:two',
            runtimeSecretRefs: { bot_token: 'same-bot', app_token: 'same' },
          },
        },
        runtime: {},
      },
      channelOpts: {
        ...channelOpts(),
        onMessageAttachmentsDeleted,
      },
      inboundEnabled: true,
      connectedChannels: [],
      connectedChannelLeases: [],
      inboundLeasePrefix: 'runtime:provider-inbound',
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    await firstDeletionCallback?.({
      providerId: 'slack',
      channelId: 'C123',
      fallbackConversationJid: 'sl:C123',
      requireStoredMessageMatch: true,
      fallbackMatchesThreadedRows: true,
      externalMessageIds: ['message-1'],
      deletedAt: '2026-08-01T00:00:00.000Z',
    });

    expect(onMessageAttachmentsDeleted).toHaveBeenCalledOnce();
    expect(onMessageAttachmentsDeleted).toHaveBeenCalledWith({
      providerId: 'slack',
      providerAccountIds: ['slack_one', 'slack_two'],
      channelId: 'C123',
      fallbackConversationJid: 'sl:C123',
      requireStoredMessageMatch: true,
      fallbackMatchesThreadedRows: true,
      externalMessageIds: ['message-1'],
      deletedAt: '2026-08-01T00:00:00.000Z',
    });
  });

  it.each([
    [['stored', 'dropped'], 'stored'],
    [['dropped', 'dropped'], 'dropped'],
  ] as const)(
    'transfers fan-out ownership when any target stores: %j',
    async (deliveryResults, expected) => {
      const onMessage = vi
        .fn<ChannelOpts['onMessage']>()
        .mockResolvedValueOnce(deliveryResults[0])
        .mockResolvedValueOnce(deliveryResults[1]);
      const inboundOnMessage = await sharedInboundOnMessage(onMessage);

      await expect(inboundOnMessage('sl:C123', fanOutMessage)).resolves.toBe(
        expected,
      );
    },
  );

  it('propagates fan-out rejection with sibling storage ownership', async () => {
    const persistenceError = new Error('second target rejected');
    const onMessage = vi
      .fn<ChannelOpts['onMessage']>()
      .mockResolvedValueOnce('stored')
      .mockRejectedValueOnce(persistenceError);
    const inboundOnMessage = await sharedInboundOnMessage(onMessage);

    await expect(
      inboundOnMessage('sl:C123', fanOutMessage),
    ).rejects.toMatchObject<Partial<InboundMessageDeliveryError>>({
      name: 'InboundMessageDeliveryError',
      stored: true,
      failures: [persistenceError],
    });
  });

  it('persists standalone provider-account channel-connect metadata without a message', async () => {
    let firstOnChatMetadata: ChannelOpts['onChatMetadata'] | undefined;
    const opts = channelOpts();
    const create = vi.fn<Provider['create']>(async (channelCreateOpts) => {
      firstOnChatMetadata ??= channelCreateOpts.onChatMetadata;
      return channel();
    });

    await connectProviderAccountChannels({
      provider: provider(create),
      appId: 'app-one',
      runtimeSettings: {
        providerAccounts: {
          slack_one: {
            provider: 'slack',
            agentId: 'agent:one',
            runtimeSecretRefs: { app_token: 'same', bot_token: 'same-bot' },
          },
          slack_two: {
            provider: 'slack',
            agentId: 'agent:two',
            runtimeSecretRefs: { bot_token: 'same-bot', app_token: 'same' },
          },
        },
        runtime: {},
      },
      channelOpts: opts,
      inboundEnabled: true,
      connectedChannels: [],
      connectedChannelLeases: [],
      inboundLeasePrefix: 'runtime:provider-inbound',
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    await firstOnChatMetadata?.(
      'sl:C123',
      '2026-07-01T00:00:00.000Z',
      'team-chat',
      'slack',
      true,
      { providerAccountId: 'slack_one' },
    );

    expect(opts.onChatMetadata).toHaveBeenCalledTimes(2);
    expect(opts.onChatMetadata).toHaveBeenNthCalledWith(
      1,
      'sl:C123',
      '2026-07-01T00:00:00.000Z',
      'team-chat',
      'slack',
      true,
      { providerAccountId: 'slack_one' },
    );
    expect(opts.onChatMetadata).toHaveBeenNthCalledWith(
      2,
      'sl:C123',
      '2026-07-01T00:00:00.000Z',
      'team-chat',
      'slack',
      true,
      { providerAccountId: 'slack_two' },
    );
    expect(opts.onMessage).not.toHaveBeenCalled();
  });

  it('does not fan out messages already scoped by the inbound transport', async () => {
    let firstOnMessage: ChannelOpts['onMessage'] | undefined;
    const onMessage = vi.fn(async () => undefined);
    const create = vi.fn<Provider['create']>(async (opts) => {
      firstOnMessage ??= opts.onMessage;
      return channel();
    });

    await connectProviderAccountChannels({
      provider: provider(create),
      appId: 'app-one',
      runtimeSettings: {
        providerAccounts: {
          slack_one: {
            provider: 'slack',
            agentId: 'agent:one',
            runtimeSecretRefs: { app_token: 'same', bot_token: 'same-bot' },
          },
          slack_two: {
            provider: 'slack',
            agentId: 'agent:two',
            runtimeSecretRefs: { bot_token: 'same-bot', app_token: 'same' },
          },
        },
        runtime: {},
      },
      channelOpts: channelOpts(onMessage),
      inboundEnabled: true,
      connectedChannels: [],
      connectedChannelLeases: [],
      inboundLeasePrefix: 'runtime:provider-inbound',
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    await firstOnMessage?.('sl:C123', {
      id: 'msg-1',
      text: 'hello',
      sender: 'U123',
      timestamp: '2026-07-01T00:00:00.000Z',
      providerAccountId: 'slack_two',
      agentId: 'agent:two',
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith(
      'sl:C123',
      expect.objectContaining({
        providerAccountId: 'slack_two',
        agentId: 'agent:two',
      }),
    );
  });

  it('does not retry a shared inbound lease under another provider account id', async () => {
    const channels = [channel(), channel()];
    const create = vi
      .fn<Provider['create']>()
      .mockResolvedValueOnce(channels[0])
      .mockResolvedValueOnce(channels[1]);
    const tryAcquire = vi.fn(async () => undefined);

    await connectProviderAccountChannels({
      provider: provider(create),
      appId: 'app-one',
      runtimeSettings: {
        providerAccounts: {
          slack_one: {
            provider: 'slack',
            agentId: 'agent:one',
            runtimeSecretRefs: { app_token: 'same', bot_token: 'same-bot' },
          },
          slack_two: {
            provider: 'slack',
            agentId: 'agent:two',
            runtimeSecretRefs: { bot_token: 'same-bot', app_token: 'same' },
          },
        },
        runtime: { deploymentMode: 'fleet' },
      },
      channelOpts: {
        ...channelOpts(),
        runtimeLease: { tryAcquire },
      },
      inboundEnabled: true,
      connectedChannels: [],
      connectedChannelLeases: [],
      inboundLeasePrefix: 'runtime:provider-inbound',
      logger: { info: vi.fn(), warn: vi.fn() },
    });

    expect(tryAcquire).toHaveBeenCalledTimes(1);
    expect(tryAcquire).toHaveBeenCalledWith(
      'runtime:provider-inbound:slack:slack_one',
    );
    expect(channels[0].connect).toHaveBeenCalledWith({
      inbound: false,
      interactionCallbacks: false,
    });
    expect(channels[1].connect).toHaveBeenCalledWith({
      inbound: false,
      interactionCallbacks: false,
    });
  });
});
