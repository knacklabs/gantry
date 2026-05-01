import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BuiltInControlChannelProviderCatalog,
  RuntimeSecretConversationDiscovery,
} from '@core/channels/control-provider-catalog.js';
import type { ChannelInstallation } from '@core/domain/channel/channel.js';
import type { RuntimeSecretProvider } from '@core/domain/ports/runtime-secret-provider.js';

const mocks = vi.hoisted(() => ({
  listTelegramRecentChats: vi.fn(async () => ({
    ok: true,
    chats: [
      {
        chatJid: 'telegram-chat-1',
        chatTitle: 'Engineering',
        chatType: 'group',
      },
    ],
  })),
}));

vi.mock('@core/cli/telegram-chat-discovery.js', () => ({
  listTelegramRecentChats: mocks.listTelegramRecentChats,
}));

vi.mock('@core/cli/slack-chat-discovery.js', () => ({
  listSlackRecentChats: vi.fn(async () => ({ ok: true, chats: [] })),
}));

function installation(runtimeSecretRefs: string[]): ChannelInstallation {
  return {
    id: 'installation-1',
    appId: 'app-one',
    providerId: 'telegram',
    label: 'Telegram',
    status: 'active',
    config: {},
    runtimeSecretRefs,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  } as ChannelInstallation;
}

function secrets(values: Record<string, string>): RuntimeSecretProvider {
  return {
    getSecret(ref) {
      const value = values[ref.env];
      if (!value) throw new Error(`Missing ${ref.env}`);
      return value;
    },
    getOptionalSecret(ref) {
      return values[ref.env];
    },
  };
}

describe('RuntimeSecretConversationDiscovery', () => {
  beforeEach(() => {
    mocks.listTelegramRecentChats.mockClear();
  });

  it('does not fall back to preferred host env names when refs are empty', async () => {
    const discovery = new RuntimeSecretConversationDiscovery(
      secrets({ TELEGRAM_BOT_TOKEN: 'host-token' }),
    );

    await expect(
      discovery.discover({ installation: installation([]), limit: 10 }),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
    });
    expect(mocks.listTelegramRecentChats).not.toHaveBeenCalled();
  });

  it('uses referenced runtime secrets for provider discovery', async () => {
    const discovery = new RuntimeSecretConversationDiscovery(
      secrets({ TELEGRAM_BOT_TOKEN: 'ref-token' }),
    );

    await expect(
      discovery.discover({
        installation: installation(['TELEGRAM_BOT_TOKEN']),
        limit: 10,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        externalId: 'telegram-chat-1',
        kind: 'group',
      }),
    ]);
    expect(mocks.listTelegramRecentChats).toHaveBeenCalledWith({
      token: 'ref-token',
      limit: 10,
    });
  });
});

describe('BuiltInControlChannelProviderCatalog', () => {
  it('lists Teams as an installable discoverable provider, not a placeholder', () => {
    const catalog = new BuiltInControlChannelProviderCatalog();

    const teams = catalog
      .listProviders()
      .find((provider) => provider.id === 'teams');

    expect(teams).toEqual(
      expect.objectContaining({
        id: 'teams',
        displayName: 'Teams',
        capabilityFlags: expect.arrayContaining(['install', 'discover']),
      }),
    );
    expect(teams?.capabilityFlags).not.toContain('placeholder');
  });
});
