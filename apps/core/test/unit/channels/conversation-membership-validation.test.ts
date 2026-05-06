import { afterEach, describe, expect, it, vi } from 'vitest';

import { RuntimeSecretConversationMembershipValidator } from '@core/channels/conversation-membership-validation.js';

const iso = '2026-05-01T00:00:00.000Z';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RuntimeSecretConversationMembershipValidator', () => {
  it('normalizes Telegram prefix provider IDs before validating approvers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          result: { status: 'member' },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const validator = new RuntimeSecretConversationMembershipValidator({
      getSecret(ref) {
        const value = this.getOptionalSecret(ref);
        if (!value) throw new Error(`missing ${ref.env}`);
        return value;
      },
      getOptionalSecret(ref) {
        return { TELEGRAM_BOT_TOKEN: '123:telegram-token' }[ref.env];
      },
    });

    const result = await validator.validateControlApprovers({
      providerId: 'tg' as never,
      providerConnection: {
        id: 'providerConnection-tg',
        appId: 'default' as never,
        providerId: 'tg' as never,
        label: 'Telegram',
        status: 'active',
        config: {},
        runtimeSecretRefs: ['TELEGRAM_BOT_TOKEN'],
        createdAt: iso,
        updatedAt: iso,
      },
      conversation: {
        id: 'conversation:tg:-100123' as never,
        appId: 'default' as never,
        providerConnectionId: 'providerConnection-tg' as never,
        externalRef: { kind: 'conversation', value: 'tg:-100123' },
        kind: 'group',
        title: 'Main Agent Telegram Group',
        status: 'active',
        createdAt: iso,
        updatedAt: iso,
      },
      userIds: ['5759865942'],
    });

    expect(result).toEqual({
      validUserIds: ['5759865942'],
      invalidUserIds: [],
      reason: undefined,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.telegram.org/bot123%3Atelegram-token/getChatMember?chat_id=-100123&user_id=5759865942',
      expect.any(Object),
    );
  });

  it('validates Teams approvers through Microsoft Graph conversation members', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'graph-token' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [
              {
                id: 'membership-1',
                userId: 'teams-user-1',
                email: 'admin@example.com',
              },
            ],
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const validator = new RuntimeSecretConversationMembershipValidator({
      getSecret(ref) {
        const value = this.getOptionalSecret(ref);
        if (!value) throw new Error(`missing ${ref.env}`);
        return value;
      },
      getOptionalSecret(ref) {
        return {
          TEAMS_CLIENT_ID: 'client-id',
          TEAMS_CLIENT_SECRET: 'client-secret',
          TEAMS_TENANT_ID: 'tenant-id',
        }[ref.env];
      },
    });

    const result = await validator.validateControlApprovers({
      providerId: 'teams' as never,
      providerConnection: {
        id: 'providerConnection-1',
        appId: 'default' as never,
        providerId: 'teams' as never,
        label: 'Teams',
        status: 'active',
        config: {},
        runtimeSecretRefs: [
          'TEAMS_CLIENT_ID',
          'TEAMS_CLIENT_SECRET',
          'TEAMS_TENANT_ID',
        ],
        createdAt: iso,
        updatedAt: iso,
      },
      conversation: {
        id: 'conversation-1' as never,
        appId: 'default' as never,
        providerConnectionId: 'providerConnection-1' as never,
        externalRef: { kind: 'conversation', value: 'teams:19:abc@thread.v2' },
        kind: 'channel',
        title: 'Engineering',
        status: 'active',
        createdAt: iso,
        updatedAt: iso,
      },
      userIds: ['teams-user-1', 'outsider-1'],
    });

    expect(result).toEqual({
      validUserIds: ['teams-user-1'],
      invalidUserIds: ['outsider-1'],
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://graph.microsoft.com/v1.0/chats/19%3Aabc%40thread.v2/members',
      expect.objectContaining({
        headers: { authorization: 'Bearer graph-token' },
      }),
    );
  });

  it('uses Teams channel membership endpoint and follows pagination when team and channel IDs are configured', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'graph-token' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [{ userId: 'teams-user-1' }],
            '@odata.nextLink':
              'https://graph.microsoft.com/v1.0/next-page-token',
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            value: [{ userPrincipalName: 'teams-user-2' }],
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);

    const validator = new RuntimeSecretConversationMembershipValidator({
      getSecret(ref) {
        const value = this.getOptionalSecret(ref);
        if (!value) throw new Error(`missing ${ref.env}`);
        return value;
      },
      getOptionalSecret(ref) {
        return {
          TEAMS_CLIENT_ID: 'client-id',
          TEAMS_CLIENT_SECRET: 'client-secret',
          TEAMS_TENANT_ID: 'tenant-id',
        }[ref.env];
      },
    });

    const result = await validator.validateControlApprovers({
      providerId: 'teams' as never,
      providerConnection: {
        id: 'providerConnection-2',
        appId: 'default' as never,
        providerId: 'teams' as never,
        label: 'Teams',
        status: 'active',
        config: {
          teamId: 'team-1',
          channelId: 'channel-1',
        },
        runtimeSecretRefs: [
          'TEAMS_CLIENT_ID',
          'TEAMS_CLIENT_SECRET',
          'TEAMS_TENANT_ID',
        ],
        createdAt: iso,
        updatedAt: iso,
      },
      conversation: {
        id: 'conversation-2' as never,
        appId: 'default' as never,
        providerConnectionId: 'providerConnection-2' as never,
        externalRef: { kind: 'conversation', value: 'teams:19:def@thread.v2' },
        kind: 'channel',
        title: 'Design',
        status: 'active',
        createdAt: iso,
        updatedAt: iso,
      },
      userIds: ['teams-user-1', 'teams-user-2', 'outsider-1'],
    });

    expect(result).toEqual({
      validUserIds: ['teams-user-1', 'teams-user-2'],
      invalidUserIds: ['outsider-1'],
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://graph.microsoft.com/v1.0/teams/team-1/channels/channel-1/members',
      expect.objectContaining({
        headers: { authorization: 'Bearer graph-token' },
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      'https://graph.microsoft.com/v1.0/next-page-token',
      expect.objectContaining({
        headers: { authorization: 'Bearer graph-token' },
      }),
    );
  });
});
