import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BuiltInControlChannelProviderCatalog,
  RuntimeSecretConversationDiscovery,
} from '@core/channels/control-provider-catalog.js';
import type { ProviderConnection } from '@core/domain/provider/provider.js';
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
  listTeamsChannels: vi.fn(async () => ({
    ok: true,
    channels: [
      {
        chatJid: 'teams:19:general@thread.tacv2',
        chatTitle: 'Engineering / General',
        teamId: 'team-1',
        channelId: '19:general@thread.tacv2',
        channelType: 'standard',
      },
    ],
  })),
  listSlackRecentChats: vi.fn(async () => ({
    ok: true,
    chats: [
      {
        chatJid: 'sl:C123',
        chatTitle: 'Engineering',
        chatType: 'channel',
      },
    ],
  })),
  listDiscordChannels: vi.fn(async () => ({
    ok: true,
    channels: [
      {
        chatJid: 'dc:1234567890',
        chatTitle: 'Engineering / #general',
        guildId: '987654321',
        channelId: '1234567890',
        channelType: 'text',
      },
    ],
  })),
}));

vi.mock('@core/cli/telegram-chat-discovery.js', () => ({
  listTelegramRecentChats: mocks.listTelegramRecentChats,
}));

vi.mock('@core/cli/slack-chat-discovery.js', () => ({
  listSlackRecentChats: mocks.listSlackRecentChats,
}));

function providerConnection(runtimeSecretRefs: string[]): ProviderConnection {
  return {
    id: 'providerConnection-1',
    appId: 'app-one',
    providerId: 'telegram',
    label: 'Telegram',
    status: 'active',
    config: {},
    runtimeSecretRefs,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  } as ProviderConnection;
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

function teamsDiscoveryClient() {
  return {
    validateCredentials: vi.fn(),
    verifyChannel: vi.fn(),
    listChannels: mocks.listTeamsChannels,
  };
}

function discordDiscoveryClient() {
  return {
    validateCredentials: vi.fn(),
    verifyChannel: vi.fn(),
    registerGantryCommand: vi.fn(),
    listChannels: mocks.listDiscordChannels,
  };
}

describe('RuntimeSecretConversationDiscovery', () => {
  beforeEach(() => {
    mocks.listTelegramRecentChats.mockClear();
    mocks.listTeamsChannels.mockClear();
    mocks.listSlackRecentChats.mockClear();
    mocks.listDiscordChannels.mockClear();
  });

  it('does not fall back to preferred host env names when refs are empty', async () => {
    const discovery = new RuntimeSecretConversationDiscovery(
      secrets({ TELEGRAM_BOT_TOKEN: 'host-token' }),
    );

    await expect(
      discovery.discover({
        providerConnection: providerConnection([]),
        limit: 10,
      }),
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
        providerConnection: providerConnection(['TELEGRAM_BOT_TOKEN']),
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

  it('discovers Teams channels from referenced runtime secrets', async () => {
    const discovery = new RuntimeSecretConversationDiscovery(
      secrets({
        TEAMS_CLIENT_ID: 'client-id',
        TEAMS_CLIENT_SECRET: 'client-secret',
        TEAMS_TENANT_ID: 'tenant-id',
      }),
      teamsDiscoveryClient(),
    );
    const teamsInstallation = {
      ...providerConnection([
        'TEAMS_CLIENT_ID',
        'TEAMS_CLIENT_SECRET',
        'TEAMS_TENANT_ID',
      ]),
      providerId: 'teams' as never,
      label: 'Teams',
    } as ProviderConnection;

    await expect(
      discovery.discover({
        providerConnection: teamsInstallation,
        limit: 10,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        externalId: '19:general@thread.tacv2',
        title: 'Engineering / General',
        kind: 'channel',
        externalRef: {
          kind: 'conversation',
          value: '19:general@thread.tacv2',
        },
      }),
    ]);
    expect(mocks.listTeamsChannels).toHaveBeenCalledWith({
      credentials: {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      limit: 10,
      includeArchived: undefined,
    });
  });

  it('normalizes Slack provider-native channels into conversations', async () => {
    const discovery = new RuntimeSecretConversationDiscovery(
      secrets({ SLACK_BOT_TOKEN: 'xoxb-token' }),
    );
    const slackConnection = {
      ...providerConnection(['SLACK_BOT_TOKEN']),
      providerId: 'slack' as never,
      label: 'Slack',
    } as ProviderConnection;

    await expect(
      discovery.discover({
        providerConnection: slackConnection,
        limit: 10,
      }),
    ).resolves.toEqual([
      {
        externalId: 'C123',
        title: 'Engineering',
        kind: 'channel',
        externalRef: { kind: 'conversation', value: 'C123' },
      },
    ]);
    expect(mocks.listSlackRecentChats).toHaveBeenCalledWith({
      botToken: 'xoxb-token',
      limit: 10,
      includeArchived: undefined,
    });
  });

  it('discovers Discord channels from referenced runtime secrets', async () => {
    const discovery = new RuntimeSecretConversationDiscovery(
      secrets({
        DISCORD_BOT_TOKEN: 'discord-token',
        DISCORD_APPLICATION_ID: '123456789',
      }),
      teamsDiscoveryClient(),
      discordDiscoveryClient(),
    );
    const discordConnection = {
      ...providerConnection(['DISCORD_BOT_TOKEN', 'DISCORD_APPLICATION_ID']),
      providerId: 'discord' as never,
      label: 'Discord',
    } as ProviderConnection;

    await expect(
      discovery.discover({
        providerConnection: discordConnection,
        limit: 10,
      }),
    ).resolves.toEqual([
      {
        externalId: '1234567890',
        title: 'Engineering / #general',
        kind: 'channel',
        externalRef: { kind: 'conversation', value: '1234567890' },
      },
    ]);
    expect(mocks.listDiscordChannels).toHaveBeenCalledWith({
      credentials: {
        botToken: 'discord-token',
        applicationId: '123456789',
      },
      limit: 10,
    });
  });

  it('fails Teams discovery when required runtime secret refs are missing', async () => {
    const discovery = new RuntimeSecretConversationDiscovery(
      secrets({
        TEAMS_CLIENT_ID: 'client-id',
        TEAMS_CLIENT_SECRET: 'client-secret',
        TEAMS_TENANT_ID: 'tenant-id',
      }),
      teamsDiscoveryClient(),
    );
    const teamsInstallation = {
      ...providerConnection(['TEAMS_CLIENT_ID', 'TEAMS_TENANT_ID']),
      providerId: 'teams' as never,
      label: 'Teams',
    } as ProviderConnection;

    await expect(
      discovery.discover({
        providerConnection: teamsInstallation,
        limit: 10,
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      message: 'provider connection does not reference TEAMS_CLIENT_SECRET',
    });
    expect(mocks.listTeamsChannels).not.toHaveBeenCalled();
  });

  it('filters discovered conversations by query after canonicalizing ids', async () => {
    mocks.listSlackRecentChats.mockResolvedValueOnce({
      ok: true,
      chats: [
        { chatJid: 'sl:C123', chatTitle: 'Engineering', chatType: 'channel' },
        { chatJid: 'sl:C999', chatTitle: 'Marketing', chatType: 'channel' },
      ],
    });
    const discovery = new RuntimeSecretConversationDiscovery(
      secrets({ SLACK_BOT_TOKEN: 'xoxb-token' }),
    );
    const slackConnection = {
      ...providerConnection(['SLACK_BOT_TOKEN']),
      providerId: 'slack' as never,
      label: 'Slack',
    } as ProviderConnection;

    await expect(
      discovery.discover({
        providerConnection: slackConnection,
        query: 'eng',
        limit: 10,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        externalId: 'C123',
        title: 'Engineering',
      }),
    ]);
  });

  it('threads archive controls through Slack discovery and filters archived rows', async () => {
    mocks.listSlackRecentChats.mockResolvedValueOnce({
      ok: true,
      chats: [
        {
          chatJid: 'sl:C123',
          chatTitle: 'Engineering',
          chatType: 'channel',
          isArchived: true,
        },
        { chatJid: 'sl:C999', chatTitle: 'Operations', chatType: 'channel' },
      ],
    });
    const discovery = new RuntimeSecretConversationDiscovery(
      secrets({ SLACK_BOT_TOKEN: 'xoxb-token' }),
    );
    const slackConnection = {
      ...providerConnection(['SLACK_BOT_TOKEN']),
      providerId: 'slack' as never,
      label: 'Slack',
    } as ProviderConnection;

    await expect(
      discovery.discover({
        providerConnection: slackConnection,
        includeArchived: false,
        limit: 10,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        externalId: 'C999',
        title: 'Operations',
      }),
    ]);
    expect(mocks.listSlackRecentChats).toHaveBeenCalledWith({
      botToken: 'xoxb-token',
      limit: 10,
      includeArchived: false,
    });
  });

  it('preserves archived Teams status when archive inclusion is requested', async () => {
    mocks.listTeamsChannels.mockResolvedValueOnce({
      ok: true,
      channels: [
        {
          chatJid: 'teams:19:archived@thread.tacv2',
          chatTitle: 'Engineering / Old',
          teamId: 'team-1',
          channelId: '19:archived@thread.tacv2',
          channelType: 'standard',
          isArchived: true,
        },
      ],
    });
    const discovery = new RuntimeSecretConversationDiscovery(
      secrets({
        TEAMS_CLIENT_ID: 'client-id',
        TEAMS_CLIENT_SECRET: 'client-secret',
        TEAMS_TENANT_ID: 'tenant-id',
      }),
      teamsDiscoveryClient(),
    );
    const teamsInstallation = {
      ...providerConnection([
        'TEAMS_CLIENT_ID',
        'TEAMS_CLIENT_SECRET',
        'TEAMS_TENANT_ID',
      ]),
      providerId: 'teams' as never,
      label: 'Teams',
    } as ProviderConnection;

    await expect(
      discovery.discover({
        providerConnection: teamsInstallation,
        includeArchived: true,
        limit: 10,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        externalId: '19:archived@thread.tacv2',
        status: 'archived',
      }),
    ]);
    expect(mocks.listTeamsChannels).toHaveBeenCalledWith({
      credentials: {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        tenantId: 'tenant-id',
      },
      limit: 10,
      includeArchived: true,
    });
  });
});

describe('BuiltInControlChannelProviderCatalog', () => {
  it('advertises Discord setup/discovery runtime support', () => {
    const catalog = new BuiltInControlChannelProviderCatalog();

    const discord = catalog
      .listProviders()
      .find((provider) => provider.id === 'discord');

    expect(discord).toEqual(
      expect.objectContaining({
        id: 'discord',
        displayName: 'Discord',
        capabilityFlags: expect.arrayContaining(['setup', 'discover']),
        allowedRuntimeSecretRefs: [
          'DISCORD_BOT_TOKEN',
          'DISCORD_APPLICATION_ID',
        ],
      }),
    );
    expect(discord?.capabilityFlags).not.toContain('install');
    expect(discord?.capabilityFlags).not.toContain('runtime-placeholder');
  });

  it('does not advertise Teams runtime as installable while the transport is stubbed', () => {
    const catalog = new BuiltInControlChannelProviderCatalog();

    const teams = catalog
      .listProviders()
      .find((provider) => provider.id === 'teams');

    expect(teams).toEqual(
      expect.objectContaining({
        id: 'teams',
        displayName: 'Teams',
        capabilityFlags: expect.arrayContaining([
          'setup',
          'discover',
          'runtime-placeholder',
        ]),
      }),
    );
    expect(teams?.capabilityFlags).not.toContain('install');
    expect(teams?.capabilityFlags).not.toContain('placeholder');
  });
});
