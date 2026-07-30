import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import { PostgresCanonicalGraphRepository } from '@core/adapters/storage/postgres/repositories/canonical-graph-repository.postgres.js';
import {
  DEFAULT_AGENT_ID,
  DEFAULT_APP_ID,
} from '@core/adapters/storage/postgres/seeds.js';
import { AsyncTaskQueue } from '@core/app/bootstrap/async-task-queue.js';
import { createChannelPersistenceHandlers } from '@core/app/bootstrap/channel-persistence-handlers.js';
import type { ChannelWiringDeps } from '@core/app/bootstrap/channel-wiring-types.js';
import type { RuntimeApp } from '@core/app/bootstrap/runtime-app.js';
import type { ChannelOpts } from '@core/channels/channel-provider.js';
import { ingestSlackMessage } from '@core/channels/slack/channel-message-ingest.js';
import { TeamsChannel } from '@core/channels/teams.js';
import type { TeamsSdkClient } from '@core/channels/teams-types.js';
import { handleTelegramTextMessage } from '@core/channels/telegram/text-message-handler.js';
import type { ConversationRoute } from '@core/domain/types.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';
import { measurePostgresOperations } from '../harness/response-latency-postgres.js';

// Decision 0082 baseline: stage LAT-4A-2 flips these to 19 and once.
//
// WHAT THIS MEASURES, precisely: every SQL statement issued to persist ONE
// inbound envelope — the metadata write, the message graph write, participants,
// message and part, and the admission enqueue — with the window held open until
// the persistence queue drains, so nothing is missed and nothing is sampled.
//
// It is deliberately NOT "statements before the admission wake". Review pushed
// three times on that phrasing and was right each time: the wake is not
// observed here, so a count that stopped at it would be asserting a boundary it
// never sees. The quantity below is the one LAT-4A actually reduces — the total
// persistence cost of an inbound message — and it is well-defined and
// deterministic. Decision 0082 and the plan's AC1 use this same wording.
// Per-provider, because the saving does NOT land on a shared number: each
// ingress has its own baseline shape (media skips work text does, Slack does
// slightly more). What IS uniform is the DELTA — every provider drops exactly
// nine statements, the duplicate ensureConversation this phase removes.
//
// Measured on real Postgres, before and after, by stashing the src change:
//   Telegram text   28 -> 19
//   Telegram media  22 -> 22 (NOT converted — see decision 0082)
//   Slack           29 -> 20
//   Teams           28 -> 19
// A single shared constant would have been wrong for two of the four.
const EXPECTED_ENVELOPE_STATEMENTS_BY_PROVIDER: Record<string, number> = {
  'Telegram text': 19,
  Slack: 20,
  Teams: 19,
};
// Referenced by docs/architecture/lat-4a-measurement.md; kept here so the number
// and the assertions live together.
export const STATEMENTS_SAVED_PER_PROVIDER = 9;
const EXPECTED_ENSURE_CONVERSATION_CALLS = 1;

const PRIVATE_CONVERSATION_JID = 'tg:400200';
const PRIVATE_PROVIDER_ACCOUNT_ID = 'telegram_lat_4a_unregistered_private';
const MESSAGE_TIMESTAMP = '2026-07-29T00:00:00.000Z';

describe.runIf(hasPostgresIntegrationDatabase)(
  'inbound envelope Postgres statement baseline',
  () => {
    let runtime: PostgresIntegrationRuntime;

    function createPersistenceHarness(input: {
      providerAccountId: string;
      conversationRoutes: Record<string, ConversationRoute>;
    }): {
      persistenceQueue: AsyncTaskQueue;
      channelOpts: ChannelOpts;
    } {
      const app = {
        getConversationRoutes: () => input.conversationRoutes,
      } as unknown as RuntimeApp;
      const resolved = {
        appId: DEFAULT_APP_ID,
        providerIds: [],
        opsRepository: runtime.ops,
        loadSenderAllowlist: () => ({}),
        loadSenderControlAllowlist: () => ({}),
        shouldDropMessage: () => false,
        isSenderAllowed: () => true,
        isSenderControlAllowed: () => true,
        shouldLogDenied: () => false,
        logger: {
          info: () => undefined,
          warn: () => undefined,
          debug: () => undefined,
          error: () => undefined,
        },
      } as unknown as ChannelWiringDeps;
      const persistenceQueue = new AsyncTaskQueue(1, 4);
      const handlers = createChannelPersistenceHandlers({
        app,
        resolved,
        ops: () => runtime.ops,
        persistenceQueue,
        runtimeSettings: () => ({}) as never,
      });

      return {
        persistenceQueue,
        channelOpts: {
          providerAccountId: input.providerAccountId,
          onChatMetadata: handlers.onChatMetadata,
          onMessage: handlers.onMessage,
          conversationRoutes: () => app.getConversationRoutes(),
        },
      };
    }

    beforeAll(async () => {
      runtime = await createPostgresIntegrationRuntime({
        schemaPrefix: 'inbound_envelope_statements',
      });
    }, 60_000);

    afterEach(() => {
      vi.restoreAllMocks();
    });

    afterAll(async () => {
      await runtime?.cleanup();
    });

    const registeredIngressCases: Array<{
      label: string;
      conversationJid: string;
      providerAccountId: string;
      chatName: string;
      ingest: (channelOpts: ChannelOpts) => Promise<void>;
    }> = [
      {
        label: 'Telegram text',
        conversationJid: 'tg:-100400100',
        providerAccountId: 'telegram_lat_4a_text',
        chatName: 'Telegram Text Latency',
        ingest: async (channelOpts) => {
          const ctx = {
            chat: {
              id: -100400100,
              type: 'supergroup',
              title: 'Telegram Text Latency',
            },
            from: {
              id: 400100,
              first_name: 'Latency User',
              username: 'latency_user',
            },
            message: {
              text: '@Main Measure the paired inbound envelope.',
              date: Date.parse(MESSAGE_TIMESTAMP) / 1000,
              message_id: 1,
              entities: [],
            },
            me: { username: 'gantry_latency_bot' },
          } as Parameters<typeof handleTelegramTextMessage>[0]['ctx'];
          await handleTelegramTextMessage({
            ctx,
            opts: channelOpts,
            assistantName: 'Main',
            triggerPattern: /@Main\b/i,
            tryResolveOther: async () => false,
          });
        },
      },
      {
        label: 'Slack',
        conversationJid: 'sl:C400102',
        providerAccountId: 'slack_lat_4a',
        chatName: 'Slack Latency',
        ingest: async (channelOpts) => {
          await ingestSlackMessage({
            event: {
              channel: 'C400102',
              ts: '1785283200.000100',
              user: 'U400102',
              text: 'Measure the paired inbound envelope.',
            },
            opts: channelOpts,
            botUserId: null,
            resolveChannelName: async () => 'Slack Latency',
            resolveUserName: async () => 'Slack User',
            isLikelyGroupConversation: () => true,
            enrichMessage: async () => ({
              text: 'Measure the paired inbound envelope.',
              attachments: [],
            }),
          });
        },
      },
      {
        label: 'Teams',
        conversationJid: 'teams:19:latency@thread.v2',
        providerAccountId: 'teams_lat_4a',
        chatName: 'Teams Latency',
        ingest: async (channelOpts) => {
          const sdkClient: TeamsSdkClient = {
            start: async () => undefined,
            stop: async () => undefined,
            sendMessage: async () => ({}),
          };
          const channel = new TeamsChannel(
            {
              clientId: 'client-id',
              clientSecret: 'client-secret',
              tenantId: 'tenant-id',
            },
            channelOpts,
            sdkClient,
          );
          await channel.ingestMessage({
            conversationId: '19:latency@thread.v2',
            id: 'teams-message-1',
            text: 'Measure the paired inbound envelope.',
            from: { id: 'teams-user', name: 'Teams User' },
            timestamp: MESSAGE_TIMESTAMP,
            conversationName: 'Teams Latency',
            conversationType: 'channel',
          });
        },
      },
    ];

    it.each(registeredIngressCases)(
      'persists one registered $label envelope with one conversation write',
      async ({
        label,
        conversationJid,
        providerAccountId,
        chatName,
        ingest,
      }) => {
        const route: ConversationRoute = {
          name: chatName,
          folder: 'main_agent',
          trigger: '@Main',
          added_at: MESSAGE_TIMESTAMP,
          agentId: DEFAULT_AGENT_ID,
          providerAccountId,
          requiresTrigger: true,
          conversationKind: 'channel',
        };
        const { persistenceQueue, channelOpts } = createPersistenceHarness({
          providerAccountId,
          conversationRoutes: { [conversationJid]: route },
        });

        // This spy calls through to the real graph method, so the invocation
        // executes its SQL against the isolated Postgres schema.
        const ensureConversation = vi.spyOn(
          PostgresCanonicalGraphRepository.prototype,
          'ensureConversation',
        );

        // Keep the measurement window open until asynchronous persistence
        // drains; otherwise this would be a racy sample.
        const measurement = await measurePostgresOperations(
          runtime.service.pool,
          async () => {
            await ingest(channelOpts);
            expect(await persistenceQueue.waitForIdle(5_000)).toBe(true);
          },
        );
        const observedStatements = measurement.counts.postgres_statements;

        const expectedStatements =
          EXPECTED_ENVELOPE_STATEMENTS_BY_PROVIDER[label];
        expect(
          expectedStatements,
          `no measured statement count recorded for provider '${label}' (observed ${observedStatements}) — measure it, do not guess`,
        ).toBeDefined();
        expect(observedStatements).toBe(expectedStatements);
        expect(ensureConversation).toHaveBeenCalledTimes(
          EXPECTED_ENSURE_CONVERSATION_CALLS,
        );

        // This is the first message for each group conversation. Omitting the
        // carried identity would silently leave title as the JID and kind as
        // direct.
        const conversation = await runtime.service.pool.query(
          `SELECT title, kind FROM conversations
           WHERE provider_account_id = $1 AND external_ref_json LIKE $2`,
          [providerAccountId, `%${conversationJid}%`],
        );
        expect(conversation.rows).toHaveLength(1);
        expect(conversation.rows[0].title).toBe(chatName);
        expect(conversation.rows[0].title).not.toBe(conversationJid);
        expect(conversation.rows[0].kind).toBe('group');
      },
    );

    it('propagates a later Telegram group rename through the message envelope', async () => {
      const conversationJid = 'tg:-100400105';
      const providerAccountId = 'telegram_lat_4a_text';
      const route: ConversationRoute = {
        name: 'Original Group Name',
        folder: 'main_agent',
        trigger: '@Main',
        added_at: MESSAGE_TIMESTAMP,
        agentId: DEFAULT_AGENT_ID,
        providerAccountId,
        requiresTrigger: false,
        conversationKind: 'channel',
      };
      const { persistenceQueue, channelOpts } = createPersistenceHarness({
        providerAccountId,
        conversationRoutes: { [conversationJid]: route },
      });
      const ingestTelegramMessage = async (
        title: string,
        messageId: number,
      ) => {
        const ctx = {
          chat: {
            id: -100400105,
            type: 'supergroup',
            title,
          },
          from: {
            id: 400105,
            first_name: 'Rename User',
          },
          message: {
            text: `message ${messageId}`,
            date: Date.parse(MESSAGE_TIMESTAMP) / 1000 + messageId,
            message_id: messageId,
            entities: [],
          },
          me: { username: 'gantry_latency_bot' },
        } as Parameters<typeof handleTelegramTextMessage>[0]['ctx'];
        await handleTelegramTextMessage({
          ctx,
          opts: channelOpts,
          assistantName: 'Main',
          triggerPattern: /@Main\b/i,
          tryResolveOther: async () => false,
        });
        expect(await persistenceQueue.waitForIdle(5_000)).toBe(true);
      };

      await ingestTelegramMessage('Original Group Name', 1);
      await ingestTelegramMessage('Renamed Group', 2);

      const conversation = await runtime.service.pool.query(
        `SELECT title, kind FROM conversations
         WHERE provider_account_id = $1 AND external_ref_json LIKE $2`,
        [providerAccountId, `%${conversationJid}%`],
      );
      expect(conversation.rows).toHaveLength(1);
      expect(conversation.rows[0]).toMatchObject({
        title: 'Renamed Group',
        kind: 'group',
      });
    });

    it('persists an unregistered private chat in one conversation write', async () => {
      const { persistenceQueue, channelOpts } = createPersistenceHarness({
        providerAccountId: PRIVATE_PROVIDER_ACCOUNT_ID,
        conversationRoutes: {},
      });
      const telegramContext = {
        chat: {
          id: 400200,
          type: 'private',
        },
        from: {
          id: 400200,
          first_name: 'Private Latency User',
          username: 'private_latency_user',
        },
        message: {
          text: 'Persist this unregistered private message.',
          date: Date.parse(MESSAGE_TIMESTAMP) / 1000,
          message_id: 2,
          entities: [],
        },
        me: { username: 'gantry_latency_bot' },
      } as Parameters<typeof handleTelegramTextMessage>[0]['ctx'];

      // Decision 0082: shared persistence rejects this unregistered direct
      // message, so standalone metadata is its only conversation write.
      const ensureConversation = vi.spyOn(
        PostgresCanonicalGraphRepository.prototype,
        'ensureConversation',
      );

      await measurePostgresOperations(runtime.service.pool, async () => {
        await handleTelegramTextMessage({
          ctx: telegramContext,
          opts: channelOpts,
          assistantName: 'Main',
          triggerPattern: /@Main\b/i,
          tryResolveOther: async () => false,
        });
        expect(await persistenceQueue.waitForIdle(5_000)).toBe(true);
      });

      expect(ensureConversation).toHaveBeenCalledTimes(1);

      const conversation = await runtime.service.pool.query(
        `SELECT title, kind FROM conversations
         WHERE provider_account_id = $1 AND external_ref_json LIKE $2`,
        [PRIVATE_PROVIDER_ACCOUNT_ID, `%${PRIVATE_CONVERSATION_JID}%`],
      );
      expect(conversation.rows).toHaveLength(1);
      expect(conversation.rows[0].title).not.toBeNull();
      expect(conversation.rows[0].kind).toBe('direct');
    });
  },
);
