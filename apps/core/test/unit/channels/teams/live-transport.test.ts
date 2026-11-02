import { createServer, type Server } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { SignJWT } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationBotFrameworkAuthentication } from 'botbuilder';
import { OpenIdMetadata } from 'botframework-connector/lib/auth/openIdMetadata.js';

import {
  createMicrosoftTeamsSdkClient,
  processTeamsActivity,
} from '@core/channels/teams/sdk-client.js';
import type {
  TeamsSdkClient,
  TeamsSdkStartInput,
} from '@core/channels/teams/types.js';
import { logger } from '@core/infrastructure/logging/logger.js';
import { createTeamsChannel } from '@core/channels/teams/factory.js';
import type { TeamsConversationRoute } from '@core/channels/teams/conversation-route-store.js';

const credentials = {
  clientId: 'bot-app',
  clientSecret: 'test-secret',
  tenantId: 'tenant-one',
};
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const clients: TeamsSdkClient[] = [];
const servers: Server[] = [];
const sent: Record<string, unknown>[] = [];
const providerSend = vi.fn(async (message: Record<string, unknown>) => {
  sent.push(message);
  return { id: 'reply' };
});
const routes = new Map<string, TeamsConversationRoute>();
const routeStore = {
  async upsertForProviderAccounts(input: {
    providerAccountIds: string[];
    route: TeamsConversationRoute;
  }) {
    for (const account of input.providerAccountIds)
      routes.set(account, input.route);
  },
  async get(input: { providerAccountId: string }) {
    return routes.get(input.providerAccountId) ?? null;
  },
};
const activity = (overrides: Record<string, unknown> = {}) => ({
  type: 'message',
  id: 'message-one',
  channelId: 'msteams',
  serviceUrl: 'https://smba.trafficmanager.net/region/',
  conversation: {
    id: '19:chat@thread.tacv2;messageid=root',
    conversationType: 'channel',
  },
  recipient: { id: '28:bot-app', name: 'Gantry' },
  from: { id: 'person', name: 'A person' },
  channelData: { tenant: { id: 'tenant-one' } },
  text: '<at>Gantry</at> hello',
  entities: [
    {
      type: 'mention',
      mentioned: { id: '28:bot-app' },
      text: '<at>Gantry</at>',
    },
  ],
  ...overrides,
});

async function rememberConversation() {
  await routeStore.upsertForProviderAccounts({
    providerAccountIds: ['teams_one'],
    route: {
      conversationJid: 'teams:19:chat@thread.tacv2',
      serviceUrl: activity().serviceUrl,
      tenantId: credentials.tenantId,
      botId: '28:bot-app',
      channelId: 'msteams',
      conversationType: 'channel',
    },
  });
}

async function token(audience = credentials.clientId) {
  return new SignJWT({ serviceurl: activity().serviceUrl })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer('https://api.botframework.com')
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(keys.privateKey);
}

async function listen() {
  const server = createServer((request, response) => {
    const account = new URL(request.url!, 'http://local').pathname.slice(1);
    void processTeamsActivity({
      providerAccountId: account,
      request,
      response,
    });
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No test listener');
  return `http://127.0.0.1:${address.port}`;
}

async function start(
  account = 'teams_one',
  onMessage: TeamsSdkStartInput['onMessage'] = vi.fn(async () => {}),
  inbound = true,
  aliases = [account],
) {
  const client = createMicrosoftTeamsSdkClient(credentials, {
    providerAccountId: account,
    inboundProviderAccountIds: aliases,
    routeStore,
  });
  expect(client).not.toBeNull();
  clients.push(client!);
  await client!.start({ credentials, onMessage, inbound });
  return client!;
}

beforeEach(() => {
  sent.length = 0;
  routes.clear();
  providerSend.mockReset().mockImplementation(async (message) => {
    sent.push(message);
    return { id: 'reply' };
  });
  vi.spyOn(OpenIdMetadata.prototype, 'getKey').mockResolvedValue({
    key: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    endorsements: ['msteams'],
  });
  const connector = {
    conversations: {
      sendToConversation: vi.fn(
        async (_conversation: string, message: Record<string, unknown>) => {
          return providerSend(message);
        },
      ),
      replyToActivity: vi.fn(
        async (
          _conversation: string,
          _root: string,
          message: Record<string, unknown>,
        ) => {
          return providerSend(message);
        },
      ),
      updateActivity: vi.fn(async () => ({ id: 'updated' })),
    },
  };
  vi.spyOn(
    ConfigurationBotFrameworkAuthentication.prototype,
    'createConnectorFactory',
  ).mockReturnValue({ create: async () => connector } as never);
  vi.spyOn(
    ConfigurationBotFrameworkAuthentication.prototype,
    'createUserTokenClient',
  ).mockResolvedValue({} as never);
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.stop()));
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
  vi.restoreAllMocks();
});

describe('authenticated Teams transport', () => {
  it('selects all sibling aliases without a last-client winner and replies in the canonical thread', async () => {
    const received = vi.fn(async () => {});
    const first = await start('teams_one', received, true, [
      'teams_one',
      'teams_alias',
    ]);
    const other = vi.fn(async () => {});
    await start('teams_two', other);
    const base = await listen();
    const result = await fetch(`${base}/teams_alias`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${await token()}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(activity()),
    });
    expect(result.status).toBe(200);
    expect(received).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: '19:chat@thread.tacv2',
        threadId: 'root',
        text: 'hello',
      }),
    );
    expect(other).not.toHaveBeenCalled();
    expect(routes.get('teams_alias')).toMatchObject({
      conversationJid: 'teams:19:chat@thread.tacv2',
      tenantId: 'tenant-one',
    });
    await first.sendMessage({
      conversationId: '19:chat@thread.tacv2',
      text: 'reply',
      threadId: 'root',
    });
    expect(sent).toContainEqual(
      expect.objectContaining({ text: 'reply', replyToId: 'root' }),
    );
  });

  it('returns unavailable for an outbound-only account and for an alias after stop', async () => {
    const outbound = await start(
      'teams_outbound',
      vi.fn(async () => {}),
      false,
    );
    const base = await listen();
    expect(
      (
        await fetch(`${base}/teams_outbound`, {
          method: 'POST',
          body: 'not JSON',
        })
      ).status,
    ).toBe(503);
    await outbound.stop();
    const inbound = await start();
    await inbound.stop();
    expect(
      (await fetch(`${base}/teams_one`, { method: 'POST', body: 'not JSON' }))
        .status,
    ).toBe(503);
  });

  it.each(['unsigned', 'wrong audience'] as const)(
    'rejects %s before route capture or message handling',
    async (kind) => {
      const received = vi.fn(async () => {});
      await start('teams_one', received);
      const base = await listen();
      const authorization =
        kind === 'unsigned'
          ? `Bearer ${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from(JSON.stringify({ iss: 'https://api.botframework.com', aud: credentials.clientId })).toString('base64url')}.`
          : `Bearer ${await token('another-bot')}`;
      const response = await fetch(`${base}/teams_one`, {
        method: 'POST',
        headers: { authorization },
        body: JSON.stringify(activity()),
      });
      expect(response.status).toBe(401);
      expect(received).not.toHaveBeenCalled();
      expect(routes.size).toBe(0);
      expect(await response.text()).not.toContain(credentials.clientSecret);
    },
  );

  it('refuses a different tenant before storing its route or handling its message', async () => {
    const received = vi.fn(async () => {});
    await start('teams_one', received);
    const base = await listen();
    const response = await fetch(`${base}/teams_one`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}` },
      body: JSON.stringify(
        activity({ channelData: { tenant: { id: 'another-tenant' } } }),
      ),
    });
    expect(response.status).toBe(403);
    expect(received).not.toHaveBeenCalled();
    expect(routes.size).toBe(0);
  });

  it('waits for inbound save and returns a safe non-success response when saving fails', async () => {
    const warning = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    let fail!: (error: Error) => void;
    let entered!: () => void;
    const handling = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const saving = new Promise<void>((_resolve, reject) => {
      fail = reject;
    });
    await start('teams_one', async () => {
      entered();
      await saving;
    });
    const base = await listen();
    let acknowledged = false;
    const request = fetch(`${base}/teams_one`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}` },
      body: JSON.stringify(activity()),
    }).then((response) => {
      acknowledged = true;
      return response;
    });
    await handling;
    expect(acknowledged).toBe(false);
    fail(new Error('secret card value'));
    const response = await request;
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('secret card value');
    expect(warning).toHaveBeenCalledWith(
      {
        providerId: 'teams',
        activityType: 'message',
        outcome: 'handling_failed',
      },
      'Teams activity could not be handled',
    );
  });

  it('passes a message-based card submit to the existing action pipeline', async () => {
    const received = vi.fn(async () => {});
    await start('teams_one', received);
    const base = await listen();
    const value = { action: 'permission_decision', decision: 'allow_once' };
    const response = await fetch(`${base}/teams_one`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}` },
      body: JSON.stringify(activity({ text: '', value })),
    });
    expect(response.status).toBe(200);
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ value }));
  });

  it.each([false, true])(
    'returns the invoke envelope when handling failure is %s',
    async (fails) => {
      const received = vi.fn(async () => {
        if (fails) throw new Error('private card value');
      });
      await start('teams_one', received);
      const base = await listen();
      const response = await fetch(`${base}/teams_one`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await token()}` },
        body: JSON.stringify(
          activity({
            type: 'invoke',
            name: 'adaptiveCard/action',
            value: {
              action: {
                type: 'Action.Execute',
                data: { decision: 'allow_once' },
              },
            },
          }),
        ),
      });
      // Handled invokes use HTTP 200; Teams reads failures from the envelope.
      expect(response.status).toBe(200);
      const envelope = await response.json();
      expect(JSON.stringify(envelope)).not.toContain('private card value');
      expect(envelope).toMatchObject({
        statusCode: fails ? 500 : 200,
        type: fails
          ? 'application/vnd.microsoft.error'
          : 'application/vnd.microsoft.activity.message',
      });
      expect(received).toHaveBeenCalledWith(
        expect.objectContaining({ value: { decision: 'allow_once' } }),
      );
    },
  );

  it('splits an oversized Microsoft connector payload and delivers all text in the originating thread', async () => {
    const client = await start(
      'teams_one',
      vi.fn(async () => {}),
      false,
    );
    await rememberConversation();
    const channel = await createTeamsChannel(
      {
        providerAccountId: 'teams_one',
        onMessage: async () => 'stored',
        onChatMetadata: async () => {},
        conversationRoutes: () => ({}),
      },
      { credentials, sdkClient: client },
    );
    if (!channel) throw new Error('Expected configured Teams channel');
    await channel.connect({ inbound: false });
    const text = '🙂'.repeat(2501);
    providerSend.mockRejectedValueOnce(
      Object.assign(new Error('private Microsoft response'), {
        statusCode: 413,
      }),
    );

    try {
      const result = await channel.sendMessage(
        'teams:19:chat@thread.tacv2',
        text,
        { threadId: 'root' },
      );
      expect(result).toMatchObject({
        deliveredParts: 3,
        totalParts: 3,
        warnings: ['teams.payload_413_split_retry'],
      });
      expect(providerSend).toHaveBeenCalledTimes(4);
      expect(providerSend.mock.calls[0]![0]).toMatchObject({ text });
      expect(sent.map((message) => message.text).join('')).toBe(text);
      expect(sent).toHaveLength(3);
      for (const message of sent) {
        expect(message).toMatchObject({
          conversation: { id: '19:chat@thread.tacv2' },
          replyToId: 'root',
        });
        expect(
          Buffer.byteLength(String(message.text), 'utf8'),
        ).toBeLessThanOrEqual(5002);
        expect(String(message.text)).not.toContain('\uFFFD');
      }
    } finally {
      await channel.disconnect();
    }
  });

  it.each([
    { providerStatus: { statusCode: 413 }, expectedStatus: 413 },
    { providerStatus: { status: 429 }, expectedStatus: 429 },
    { providerStatus: { statusCode: 400 }, expectedStatus: 400 },
    { providerStatus: { statusCode: 599 }, expectedStatus: 599 },
    { providerStatus: { statusCode: '413' }, expectedStatus: undefined },
    { providerStatus: { status: 413.5 }, expectedStatus: undefined },
    { providerStatus: { statusCode: 399 }, expectedStatus: undefined },
    { providerStatus: { status: 600 }, expectedStatus: undefined },
    { providerStatus: { statusCode: NaN }, expectedStatus: undefined },
    { providerStatus: { status: Infinity }, expectedStatus: undefined },
    {
      providerStatus: { statusCode: { private: 'secret payload' } },
      expectedStatus: undefined,
    },
  ])(
    'sanitizes connector delivery errors with provider status $providerStatus',
    async ({ providerStatus, expectedStatus }) => {
      const warning = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const client = await start(
        'teams_one',
        vi.fn(async () => {}),
        false,
      );
      await rememberConversation();
      providerSend.mockRejectedValueOnce(
        Object.assign(new Error('secret payload'), providerStatus, {
          request: { headers: { authorization: credentials.clientSecret } },
          response: { body: 'secret payload' },
        }),
      );

      const error: unknown = await client
        .sendMessage({
          conversationId: '19:chat@thread.tacv2',
          text: 'hello',
          threadId: 'root',
        })
        .catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw new Error('Expected delivery error');
      expect(error.message).toMatch(/Teams delivery failed.*retry/i);
      expect(Reflect.get(error, 'status')).toBe(expectedStatus);
      expect(Object.keys(error)).toEqual(
        expectedStatus === undefined ? [] : ['status'],
      );
      expect(error).not.toHaveProperty('cause');
      expect(error.stack).not.toContain('secret payload');
      const exposed = JSON.stringify({ error, warnings: warning.mock.calls });
      expect(exposed).not.toContain('secret payload');
      expect(exposed).not.toContain(credentials.clientSecret);
      expect(sent).toEqual([]);
    },
  );

  it('makes a missing proactive route actionable without dispatching to Microsoft', async () => {
    const client = await start(
      'teams_one',
      vi.fn(async () => {}),
      false,
    );
    await expect(
      client.sendMessage({ conversationId: 'unseen', text: 'hello' }),
    ).rejects.toThrow(/Send a message.*Teams/i);
    expect(sent).toEqual([]);
  });

  it('refreshes routing from an authenticated non-message activity with conversation tenant metadata', async () => {
    const received = vi.fn(async () => {});
    await start('teams_one', received);
    const base = await listen();
    const response = await fetch(`${base}/teams_one`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await token()}` },
      body: JSON.stringify(
        activity({
          type: 'conversationUpdate',
          conversation: {
            id: '19:chat@thread.tacv2',
            tenantId: credentials.tenantId,
          },
          channelData: { team: { id: 'team' } },
        }),
      ),
    });
    expect(response.status).toBe(200);
    expect(routes.get('teams_one')).toMatchObject({
      tenantId: credentials.tenantId,
      conversationType: null,
    });
    expect(received).not.toHaveBeenCalled();
  });
});
