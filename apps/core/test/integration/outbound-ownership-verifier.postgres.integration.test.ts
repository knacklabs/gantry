import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ChannelAdapter } from '@core/channels/channel-provider.js';
import type { Provider } from '@core/channels/provider-registry.js';
import type { RuntimeSettings } from '@core/config/settings/runtime-settings.js';
import { createOutboundOwnershipVerifier } from '@core/app/bootstrap/outbound-ownership-verifier.js';
import { createChannelWiring } from '@core/app/bootstrap/channel-wiring.js';
import type { RuntimeApp } from '@core/app/bootstrap/runtime-app.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

function makeRuntimeSettings(): RuntimeSettings {
  return {
    providers: {
      telegram: { enabled: true },
      slack: { enabled: false },
      interakt: { enabled: false },
    },
  } as RuntimeSettings;
}

function makeRuntimeApp(): RuntimeApp {
  return {
    getConversationRoutes: vi.fn(() => ({})),
    setChannelRuntime: vi.fn(),
  } as unknown as RuntimeApp;
}

function makeProvider(channel: ChannelAdapter): Provider {
  return {
    id: 'telegram',
    label: 'Telegram',
    jidPrefix: 'tg:',
    folderPrefix: 'telegram_',
    isGroupJid: (jid) => jid.startsWith('tg:'),
    formatting: 'telegram-html',
    isEnabled: (settings) => settings.providers?.telegram?.enabled === true,
    create: vi.fn(() => channel),
    setup: {
      envKeys: [],
      describe: () => 'telegram',
      run: async () => undefined,
    },
  };
}

maybeDescribe('outbound ownership verifier Postgres integration', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'outbound_ownership_verifier',
    });
  }, 60_000);

  afterAll(async () => {
    await runtime?.cleanup();
  });

  it('blocks stale owner tokens before channel send and allows the current owner', async () => {
    const conversationId = 'tg:919700000001';
    const now = new Date();
    await runtime.ops.storeMessage({
      id: 'outbound-ownership-message-1',
      chat_jid: conversationId,
      provider: 'telegram',
      sender: '919700000001',
      sender_name: 'Owner Fence Customer',
      content: 'hello',
      timestamp: '2026-06-17T10:30:00.000Z',
      is_from_me: false,
      is_bot_message: false,
      thread_id: null,
    });

    const repository = runtime.storageRuntime.conversationOwnerLeases;
    const staleOwner = await repository.claimLease({
      appId: 'default',
      conversationId,
      threadId: null,
      ownerInstanceId: 'server-stale',
      leaseTtlMs: 1_000,
      now: new Date(now.getTime() - 2_000),
      reason: 'integration-stale-owner',
    });
    const currentOwner = await repository.claimLease({
      appId: 'default',
      conversationId,
      threadId: null,
      ownerInstanceId: 'server-current',
      leaseTtlMs: 45_000,
      now,
      reason: 'integration-current-owner',
    });
    const sendMessage = vi.fn(async () => ({ externalMessageId: 'tg.1' }));
    const channel: ChannelAdapter = {
      name: 'telegram',
      connect: vi.fn(async () => undefined),
      disconnect: vi.fn(async () => undefined),
      isConnected: vi.fn(() => true),
      ownsJid: vi.fn((jid) => jid === conversationId),
      sendMessage,
    };
    const wiring = createChannelWiring(makeRuntimeApp(), {
      providerIds: [makeProvider(channel)],
      verifyOutboundOwnership: createOutboundOwnershipVerifier({
        verifyLeaseVersion: (input) => repository.verifyLeaseVersion(input),
      }),
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      },
      publishRuntimeEvent: vi.fn(async () => undefined),
    });
    await wiring.connectEnabledChannels(makeRuntimeSettings());

    await expect(
      wiring.sendMessage(conversationId, 'blocked stale reply', {
        durability: 'best_effort',
        messageOptions: {
          ownership: {
            appId: 'default',
            conversationId,
            threadId: null,
            ownerInstanceId: staleOwner.lease.ownerInstanceId,
            leaseVersion: staleOwner.lease.leaseVersion,
          },
        },
      }),
    ).rejects.toThrow(/outbound ownership fence/i);
    expect(sendMessage).not.toHaveBeenCalled();

    await expect(
      wiring.sendMessage(conversationId, 'current reply', {
        durability: 'best_effort',
        messageOptions: {
          ownership: {
            appId: 'default',
            conversationId,
            threadId: null,
            ownerInstanceId: currentOwner.lease.ownerInstanceId,
            leaseVersion: currentOwner.lease.leaseVersion,
          },
        },
      }),
    ).resolves.toBeUndefined();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(conversationId, 'current reply');
  });
});
