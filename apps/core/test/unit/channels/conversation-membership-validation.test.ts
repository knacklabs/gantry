import { afterEach, describe, expect, it, vi } from 'vitest';

import { RuntimeSecretConversationMembershipValidator } from '@core/channels/conversation-membership-validation.js';

const iso = '2026-05-01T00:00:00.000Z';

afterEach(() => {
  vi.unstubAllGlobals();
});

function secretRefName(ref: { ref?: string; env?: string }): string {
  return String(ref.ref ?? ref.env ?? '').replace(/^[^:]+:/, '');
}

describe('RuntimeSecretConversationMembershipValidator', () => {
  it('lists Slack conversation member IDs without exposing credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, members: ['U123', 'U456'] }), {
        status: 200,
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const validator = new RuntimeSecretConversationMembershipValidator({
      getSecret(ref) {
        const value = this.getOptionalSecret(ref);
        if (!value) throw new Error(`missing ${secretRefName(ref)}`);
        return value;
      },
      getOptionalSecret(ref) {
        return { SLACK_BOT_TOKEN: 'slack-token' }[secretRefName(ref)];
      },
    });

    await expect(
      validator.listConversationMemberIds({
        providerId: 'slack' as never,
        providerAccount: {
          id: 'providerAccount-slack',
          appId: 'default' as never,
          agentId: 'main_agent' as never,
          providerId: 'slack' as never,
          label: 'Slack',
          status: 'active',
          config: {},
          runtimeSecretRefs: { bot_token: 'env:SLACK_BOT_TOKEN' },
          createdAt: iso,
          updatedAt: iso,
        },
        conversation: {
          id: 'conversation:slack:C123' as never,
          appId: 'default' as never,
          providerAccountId: 'providerAccount-slack' as never,
          externalRef: { kind: 'conversation', value: 'slack:C123' },
          kind: 'channel',
          title: 'Support',
          status: 'active',
          createdAt: iso,
          updatedAt: iso,
        },
        userIds: [],
      }),
    ).resolves.toEqual(['U123', 'U456']);
  });

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
        if (!value) throw new Error(`missing ${secretRefName(ref)}`);
        return value;
      },
      getOptionalSecret(ref) {
        return { TELEGRAM_BOT_TOKEN: '123:telegram-token' }[secretRefName(ref)];
      },
    });

    const result = await validator.validateControlApprovers({
      providerId: 'tg' as never,
      providerAccount: {
        id: 'providerAccount-tg',
        appId: 'default' as never,
        agentId: 'main_agent' as never,
        providerId: 'tg' as never,
        label: 'Telegram',
        status: 'active',
        config: {},
        runtimeSecretRefs: { bot_token: 'env:TELEGRAM_BOT_TOKEN' },
        createdAt: iso,
        updatedAt: iso,
      },
      conversation: {
        id: 'conversation:tg:-100123' as never,
        appId: 'default' as never,
        providerAccountId: 'providerAccount-tg' as never,
        externalRef: { kind: 'conversation', value: 'tg:-100123' },
        kind: 'group',
        title: 'Default Agent Telegram Group',
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

  it.each([
    { name: 'chat', kind: 'group', configuredTeam: false, denied: false },
    {
      name: 'discovered channel',
      kind: 'channel',
      configuredTeam: false,
      denied: false,
    },
    {
      name: 'channel on a configured team',
      kind: 'channel',
      configuredTeam: true,
      denied: false,
    },
    {
      name: 'channel without member consent',
      kind: 'channel',
      configuredTeam: false,
      denied: true,
    },
  ] as const)(
    'verifies approvers for the selected Teams $name',
    async ({ kind, configuredTeam, denied }) => {
      const graph = 'https://graph.microsoft.com/v1.0';
      const members = {
        value: [{ userId: 'teams-user-1' }],
        '@odata.nextLink': `${graph}/member-page-2`,
      };
      const resources: Record<string, object> = {
        [`${graph}/teams?$select=id`]: {
          value: [{ id: 'team-1' }],
          '@odata.nextLink': `${graph}/teams-page-2`,
        },
        [`${graph}/teams-page-2`]: { value: [{ id: 'team-2' }] },
        [`${graph}/teams/team-1/channels?$select=id`]: {
          value: [{ id: '19:other@thread.tacv2' }],
        },
        [`${graph}/teams/team-2/channels?$select=id`]: {
          value: [],
          '@odata.nextLink': `${graph}/channels-page-2`,
        },
        [`${graph}/channels-page-2`]: {
          value: [{ id: '19:selected@thread.tacv2' }],
        },
        [`${graph}/member-page-2`]: { value: [{ userId: 'teams-user-2' }] },
      };
      const memberUrl =
        kind === 'channel'
          ? `${graph}/teams/team-2/channels/19%3Aselected%40thread.tacv2/members`
          : `${graph}/chats/19%3Aselected%40thread.v2/members`;
      const fetchMock = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (
          url ===
          'https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token'
        ) {
          return Response.json({ access_token: 'graph-token' });
        }
        if (url === memberUrl)
          return denied
            ? Response.json({}, { status: 403 })
            : Response.json(members);
        return resources[url]
          ? Response.json(resources[url])
          : Response.json({}, { status: 404 });
      });
      vi.stubGlobal('fetch', fetchMock);
      const validator = new RuntimeSecretConversationMembershipValidator({
        getSecret(ref) {
          const value = this.getOptionalSecret(ref);
          if (!value) throw new Error(`missing ${secretRefName(ref)}`);
          return value;
        },
        getOptionalSecret(ref) {
          return {
            TEAMS_CLIENT_ID: 'client-id',
            TEAMS_CLIENT_SECRET: 'client-secret',
            TEAMS_TENANT_ID: 'tenant-id',
          }[secretRefName(ref)];
        },
      });
      const result = await validator.validateControlApprovers({
        providerId: 'teams' as never,
        providerAccount: {
          id: 'providerAccount-1',
          appId: 'default' as never,
          agentId: 'main_agent' as never,
          providerId: 'teams' as never,
          label: 'Teams',
          status: 'active',
          config: configuredTeam
            ? { teamId: 'team-2', channelId: '19:other@thread.tacv2' }
            : {},
          runtimeSecretRefs: {
            client_id: 'env:TEAMS_CLIENT_ID',
            client_secret: 'env:TEAMS_CLIENT_SECRET',
            tenant_id: 'env:TEAMS_TENANT_ID',
          },
          createdAt: iso,
          updatedAt: iso,
        },
        conversation: {
          id: 'conversation-1' as never,
          appId: 'default' as never,
          providerAccountId: 'providerAccount-1' as never,
          externalRef: {
            kind: 'conversation',
            value:
              kind === 'channel'
                ? 'teams:19:selected@thread.tacv2'
                : 'teams:19:selected@thread.v2',
          },
          kind,
          title: 'Engineering',
          status: 'active',
          createdAt: iso,
          updatedAt: iso,
        },
        userIds: ['teams-user-1', 'teams-user-2', 'outsider-1'],
      });
      expect(result).toEqual(
        denied
          ? {
              validUserIds: [],
              invalidUserIds: ['teams-user-1', 'teams-user-2', 'outsider-1'],
              reason:
                'Microsoft Graph denied access to channel members. Review the app’s channel membership permission and consent, then retry.',
            }
          : {
              validUserIds: ['teams-user-1', 'teams-user-2'],
              invalidUserIds: ['outsider-1'],
            },
      );
      expect(fetchMock).toHaveBeenCalledWith(
        memberUrl,
        expect.objectContaining({
          headers: { authorization: 'Bearer graph-token' },
        }),
      );
    },
  );

  it('validates Discord approvers with effective channel View Channel access', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ guild_id: 'guild-1', permission_overwrites: [] }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: 'guild-1', permissions: '1024' }]), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ roles: [] }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response('{}', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    const validator = new RuntimeSecretConversationMembershipValidator({
      getSecret(ref) {
        const value = this.getOptionalSecret(ref);
        if (!value) throw new Error(`missing ${secretRefName(ref)}`);
        return value;
      },
      getOptionalSecret(ref) {
        return { DISCORD_BOT_TOKEN: 'discord-token' }[secretRefName(ref)];
      },
    });

    const result = await validator.validateControlApprovers({
      providerId: 'discord' as never,
      providerAccount: {
        id: 'providerAccount-discord',
        appId: 'default' as never,
        agentId: 'main_agent' as never,
        providerId: 'discord' as never,
        label: 'Discord',
        status: 'active',
        config: {},
        runtimeSecretRefs: {
          bot_token: 'env:DISCORD_BOT_TOKEN',
          application_id: 'env:DISCORD_APPLICATION_ID',
        },
        createdAt: iso,
        updatedAt: iso,
      },
      conversation: {
        id: 'conversation:dc:1234567890' as never,
        appId: 'default' as never,
        providerAccountId: 'providerAccount-discord' as never,
        externalRef: { kind: 'conversation', value: 'dc:1234567890' },
        kind: 'channel',
        title: 'Engineering / #general',
        status: 'active',
        createdAt: iso,
        updatedAt: iso,
      },
      userIds: ['discord-user-1', 'outsider-1'],
    });

    expect(result).toEqual({
      validUserIds: ['discord-user-1'],
      invalidUserIds: ['outsider-1'],
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://discord.com/api/v10/channels/1234567890',
      expect.objectContaining({
        headers: { authorization: 'Bot discord-token' },
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://discord.com/api/v10/guilds/guild-1/roles',
      expect.objectContaining({
        headers: { authorization: 'Bot discord-token' },
      }),
    );
  });

  it('rejects Discord approvers denied channel visibility by overwrites', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            guild_id: 'guild-1',
            permission_overwrites: [
              { id: 'guild-1', type: 0, allow: '0', deny: '1024' },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: 'guild-1', permissions: '1024' }]), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ roles: [] }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const validator = new RuntimeSecretConversationMembershipValidator({
      getSecret(ref) {
        const value = this.getOptionalSecret(ref);
        if (!value) throw new Error(`missing ${secretRefName(ref)}`);
        return value;
      },
      getOptionalSecret(ref) {
        return { DISCORD_BOT_TOKEN: 'discord-token' }[secretRefName(ref)];
      },
    });

    const result = await validator.validateControlApprovers({
      providerId: 'discord' as never,
      providerAccount: {
        id: 'providerAccount-discord',
        appId: 'default' as never,
        agentId: 'main_agent' as never,
        providerId: 'discord' as never,
        label: 'Discord',
        status: 'active',
        config: {},
        runtimeSecretRefs: { bot_token: 'env:DISCORD_BOT_TOKEN' },
        createdAt: iso,
        updatedAt: iso,
      },
      conversation: {
        id: 'conversation:dc:1234567890' as never,
        appId: 'default' as never,
        providerAccountId: 'providerAccount-discord' as never,
        externalRef: { kind: 'conversation', value: 'dc:1234567890' },
        kind: 'channel',
        title: 'Engineering / #private',
        status: 'active',
        createdAt: iso,
        updatedAt: iso,
      },
      userIds: ['discord-user-1'],
    });

    expect(result).toEqual({
      validUserIds: [],
      invalidUserIds: ['discord-user-1'],
    });
  });
});
