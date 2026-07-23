import { describe, expect, it, vi } from 'vitest';

import { connectProviderAccountChannels } from '@core/channels/provider-account-channel-connect.js';
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

function provider(create: Provider['create']): Provider {
  return {
    id: 'slack',
    label: 'Slack',
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

function channelOpts(onMessage = vi.fn(async () => undefined)): ChannelOpts {
  return {
    onMessage,
    onChatMetadata: vi.fn(async () => undefined),
    conversationRoutes: () => ({}),
  };
}

describe('connectProviderAccountChannels', () => {
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

  it('fans out shared inbound chat metadata to every matching provider account', async () => {
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
