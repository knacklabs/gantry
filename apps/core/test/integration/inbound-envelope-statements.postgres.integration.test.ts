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
import { TeamsChannel } from '@core/channels/teams/index.js';
import type { TeamsSdkClient } from '@core/channels/teams/types.js';
import { handleTelegramTextMessage } from '@core/channels/telegram/text-message-handler.js';
import type { ConversationRoute } from '@core/domain/types.js';
import {
  isSenderAllowed,
  isSenderControlAllowed,
  isTriggerAllowed,
  shouldLogDenied,
  type RuntimeSenderAllowlistConfig,
} from '@core/platform/sender-allowlist.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';
import { measurePostgresOperations } from '../harness/response-latency-postgres.js';

// Decisions 0085 and 0096: LAT-4A fused the envelope; LAT-4B removes the
// startup-proven and same-transaction graph repeats.
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
// deterministic. Decision 0085 and the plan's AC1 use this same wording.
// Per-provider, because the saving does NOT land on a shared number: each
// ingress has its own baseline shape (media skips work text does, Slack does
// slightly more). What IS uniform is the DELTA — every provider drops exactly
// nine statements, the duplicate ensureConversation this phase removes.
//
// Measured on real Postgres, before and after, by stashing the src change:
//   Telegram text   28 -> 19
//   Telegram media  22 -> 22 (NOT converted — see decision 0085)
//   Slack           29 -> 20
//   Teams           28 -> 19
// A single shared constant would have been wrong for two of the four.
// ID-1 sender identity adds 3 statements on a first-seen sender: the alias-key
// advisory lock, the active-alias lookup, and the retired-tombstone check (the
// person + alias inserts replace the previous participant-only write pattern).
// Repeat senders pay one more: the FOR SHARE ownership settlement that
// serializes attribution against concurrent merges.
const EXPECTED_ENVELOPE_STATEMENTS_BY_PROVIDER: Record<string, number> = {
  // LAT-4B's graph-write reduction (19 -> 15) plus ID-1's 3 first-contact
  // sender-identity statements (advisory lock, active-alias lookup,
  // retired-tombstone check).
  'Telegram text': 18,
  Slack: 18,
  Teams: 18,
};
// Referenced by docs/architecture/lat-4a-measurement.md; kept here so the number
// and the assertions live together.
export const STATEMENTS_SAVED_PER_PROVIDER = 9;
export const LAT_4B_TOP_LEVEL_STATEMENTS_SAVED = 4;
export const LAT_4B_THREAD_STATEMENTS_SAVED = 13;
// LAT-4B's 16 plus ID-1's 3 first-contact sender-identity statements.
const EXPECTED_THREAD_ENVELOPE_STATEMENTS = 19;
const EXPECTED_ENSURE_CONVERSATION_CALLS = 1;

const PRIVATE_CONVERSATION_JID = 'tg:400200';
const PRIVATE_PROVIDER_ACCOUNT_ID = 'telegram_lat_4a_unregistered_private';
const MESSAGE_TIMESTAMP = '2026-07-29T00:00:00.000Z';
const PERMISSIVE_SENDER_ALLOWLIST: RuntimeSenderAllowlistConfig = {
  telegram: {
    default: { allow: '*', mode: 'trigger' },
    agents: {},
    logDenied: false,
  },
  slack: {
    default: { allow: '*', mode: 'trigger' },
    agents: {},
    logDenied: false,
  },
  teams: {
    default: { allow: '*', mode: 'trigger' },
    agents: {},
    logDenied: false,
  },
};

describe.runIf(hasPostgresIntegrationDatabase)(
  'inbound envelope Postgres statement baseline',
  () => {
    let runtime: PostgresIntegrationRuntime;

    function createPersistenceHarness(input: {
      providerAccountId: string;
      conversationRoutes: Record<string, ConversationRoute>;
      senderAllowlist?: RuntimeSenderAllowlistConfig;
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
        loadSenderAllowlist: () =>
          input.senderAllowlist ?? PERMISSIVE_SENDER_ALLOWLIST,
        loadSenderControlAllowlist: () => ({}),
        isSenderAllowed,
        isSenderControlAllowed,
        shouldLogDenied,
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

    it('persists a first-contact Slack thread envelope in 19 statements', async () => {
      const conversationJid = 'sl:C400116';
      const providerAccountId = 'slack_lat_4b_first_thread';
      const threadId = '1785283200.000116';
      const route: ConversationRoute = {
        name: 'Slack First Thread',
        folder: 'main_agent',
        trigger: '@Main',
        added_at: MESSAGE_TIMESTAMP,
        agentId: DEFAULT_AGENT_ID,
        providerAccountId,
        requiresTrigger: false,
        conversationKind: 'channel',
      };
      await runtime.repositories.providerAccounts.saveProviderAccount({
        id: providerAccountId as never,
        appId: DEFAULT_APP_ID as never,
        agentId: DEFAULT_AGENT_ID as never,
        providerId: 'slack' as never,
        externalIdentityRef: {
          kind: 'provider_account',
          value: providerAccountId,
        },
        label: 'LAT-4B measurement account',
        status: 'active',
        config: {},
        runtimeSecretRefs: {},
        createdAt: MESSAGE_TIMESTAMP,
        updatedAt: MESSAGE_TIMESTAMP,
      });
      const { persistenceQueue, channelOpts } = createPersistenceHarness({
        providerAccountId,
        conversationRoutes: { [conversationJid]: route },
      });
      const ensureConversation = vi.spyOn(
        PostgresCanonicalGraphRepository.prototype,
        'ensureConversation',
      );

      const measurement = await measurePostgresOperations(
        runtime.service.pool,
        async () => {
          await ingestSlackMessage({
            event: {
              channel: 'C400116',
              ts: '1785283201.000116',
              thread_ts: threadId,
              user: 'U400116',
              text: 'First contact in a new thread.',
            },
            opts: channelOpts,
            botUserId: null,
            resolveChannelName: async () => route.name,
            resolveUserName: async () => 'First Thread User',
            isLikelyGroupConversation: () => true,
            enrichMessage: async () => ({
              text: 'First contact in a new thread.',
              attachments: [],
            }),
          });
          expect(await persistenceQueue.waitForIdle(5_000)).toBe(true);
        },
      );

      expect(measurement.counts.postgres_statements).toBe(
        EXPECTED_THREAD_ENVELOPE_STATEMENTS,
      );
      expect(ensureConversation).toHaveBeenCalledTimes(1);

      const envelope = await runtime.service.pool.query(
        `SELECT c.id AS conversation_id,
                ct.id AS thread_id,
                cp.id AS participant_id,
                m.id AS message_id,
                mp.id AS part_id,
                admission.id AS admission_id
         FROM conversations c
         JOIN conversation_threads ct ON ct.conversation_id = c.id
         JOIN conversation_participants cp ON cp.conversation_id = c.id
         JOIN messages m
           ON m.conversation_id = c.id AND m.thread_id = ct.id
         JOIN message_parts mp ON mp.message_id = m.id
         JOIN live_admission_work_items admission ON admission.message_id = m.id
         WHERE c.provider_account_id = $1`,
        [providerAccountId],
      );
      expect(envelope.rows).toHaveLength(1);
      expect(envelope.rows[0]).toEqual({
        conversation_id: expect.any(String),
        thread_id: expect.any(String),
        participant_id: expect.any(String),
        message_id: expect.any(String),
        part_id: expect.any(Number),
        admission_id: expect.any(String),
      });
    });

    it('orders thread traffic by monotonic message time and preserves group kind', async () => {
      const providerAccountId = 'slack_lat_4b_recency';
      const olderJid = 'sl:C400117';
      const newerJid = 'sl:C400118';
      const routes: Record<string, ConversationRoute> = {
        [olderJid]: {
          name: 'Older Conversation',
          folder: 'main_agent',
          trigger: '@Main',
          added_at: MESSAGE_TIMESTAMP,
          agentId: DEFAULT_AGENT_ID,
          providerAccountId,
          requiresTrigger: false,
          conversationKind: 'channel',
        },
        [newerJid]: {
          name: 'Newer Conversation',
          folder: 'main_agent',
          trigger: '@Main',
          added_at: MESSAGE_TIMESTAMP,
          agentId: DEFAULT_AGENT_ID,
          providerAccountId,
          requiresTrigger: false,
          conversationKind: 'channel',
        },
      };
      await runtime.repositories.providerAccounts.saveProviderAccount({
        id: providerAccountId as never,
        appId: DEFAULT_APP_ID as never,
        agentId: DEFAULT_AGENT_ID as never,
        providerId: 'slack' as never,
        externalIdentityRef: {
          kind: 'provider_account',
          value: providerAccountId,
        },
        label: 'LAT-4B recency account',
        status: 'active',
        config: {},
        runtimeSecretRefs: {},
        createdAt: MESSAGE_TIMESTAMP,
        updatedAt: MESSAGE_TIMESTAMP,
      });
      const { persistenceQueue, channelOpts } = createPersistenceHarness({
        providerAccountId,
        conversationRoutes: routes,
      });
      const ingest = async (input: {
        jid: string;
        timestamp: string;
        threadId?: string;
      }) => {
        const messageId = (Date.parse(input.timestamp) / 1000).toFixed(6);
        await ingestSlackMessage({
          event: {
            channel: input.jid.slice('sl:'.length),
            ts: messageId,
            ...(input.threadId ? { thread_ts: input.threadId } : {}),
            user: 'U400117',
            text: messageId,
          },
          opts: channelOpts,
          botUserId: null,
          resolveChannelName: async () => routes[input.jid]!.name,
          resolveUserName: async () => 'Recency User',
          isLikelyGroupConversation: () => true,
          enrichMessage: async () => ({
            text: messageId,
            attachments: [],
          }),
        });
        expect(await persistenceQueue.waitForIdle(5_000)).toBe(true);
      };
      const positions = async () => {
        // Mirrors listChats' ordering contract (ORDER BY updated_at DESC)
        // directly against the storage the chat list reads.
        const result = await runtime.service.pool.query(
          `SELECT external_ref_json::jsonb->>'jid' AS jid,
                  CASE WHEN external_ref_json::jsonb->>'isGroup' = 'true' THEN 1 ELSE 0 END AS is_group
           FROM conversations
           WHERE provider_account_id = $1
           ORDER BY updated_at DESC`,
          [providerAccountId],
        );
        const chats = result.rows as Array<{ jid: string; is_group: number }>;
        return {
          chats,
          older: chats.findIndex((chat) => chat.jid === olderJid),
          newer: chats.findIndex((chat) => chat.jid === newerJid),
        };
      };

      await ingest({
        jid: olderJid,
        timestamp: '2026-07-29T00:00:10.000Z',
      });
      await ingest({
        jid: newerJid,
        timestamp: '2026-07-29T00:00:20.000Z',
      });
      let ordered = await positions();
      expect(ordered.newer).toBeLessThan(ordered.older);

      await ingest({
        jid: olderJid,
        timestamp: '2026-07-29T00:00:05.000Z',
        threadId: '1785283210.000000',
      });
      ordered = await positions();
      expect(ordered.newer).toBeLessThan(ordered.older);
      expect(ordered.chats[ordered.older]).toMatchObject({ is_group: 1 });

      await ingest({
        jid: olderJid,
        timestamp: '2026-07-29T00:00:30.000Z',
        threadId: '1785283210.000000',
      });
      ordered = await positions();
      expect(ordered.older).toBeLessThan(ordered.newer);
      expect(ordered.chats[ordered.older]).toMatchObject({ is_group: 1 });
    });

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

    it('persists a trigger-denied Telegram sender in the channel context window', async () => {
      const conversationJid = 'tg:-100400352';
      const providerAccountId = 'telegram_gh_352_read_all';
      const sender = '400352';
      const listedSender = '999352';
      const messageId = 352;
      const messageContent = 'Store this non-listed sender for context.';
      const route: ConversationRoute = {
        name: 'GH-352 Read All',
        folder: 'main_agent',
        trigger: '@Main',
        added_at: MESSAGE_TIMESTAMP,
        agentId: DEFAULT_AGENT_ID,
        providerAccountId,
        requiresTrigger: true,
        conversationKind: 'channel',
      };
      const senderAllowlist: RuntimeSenderAllowlistConfig = {
        telegram: {
          default: { allow: [listedSender], mode: 'trigger' },
          agents: {},
          conversations: {
            [conversationJid]: {
              [route.folder]: {
                allow: [listedSender],
                mode: 'trigger',
              },
            },
          },
          logDenied: false,
        },
      };
      await runtime.repositories.providerAccounts.saveProviderAccount({
        id: providerAccountId as never,
        appId: DEFAULT_APP_ID as never,
        agentId: DEFAULT_AGENT_ID as never,
        providerId: 'telegram' as never,
        externalIdentityRef: {
          kind: 'provider_account',
          value: providerAccountId,
        },
        label: route.name,
        status: 'active',
        config: {},
        runtimeSecretRefs: {},
        createdAt: MESSAGE_TIMESTAMP,
        updatedAt: MESSAGE_TIMESTAMP,
      });
      const { persistenceQueue, channelOpts } = createPersistenceHarness({
        providerAccountId,
        conversationRoutes: { [conversationJid]: route },
        senderAllowlist,
      });

      expect(
        isTriggerAllowed(
          conversationJid,
          sender,
          senderAllowlist,
          route.folder,
        ),
      ).toBe(false);

      const ctx = {
        chat: {
          id: -100400352,
          type: 'supergroup',
          title: route.name,
        },
        from: {
          id: Number(sender),
          first_name: 'Non-listed User',
        },
        message: {
          text: messageContent,
          date: Date.parse(MESSAGE_TIMESTAMP) / 1000,
          message_id: messageId,
          entities: [],
        },
        me: { username: 'gantry_read_all_bot' },
      } as Parameters<typeof handleTelegramTextMessage>[0]['ctx'];

      await handleTelegramTextMessage({
        ctx,
        opts: channelOpts,
        assistantName: 'Main',
        triggerPattern: /@Main\b/i,
        tryResolveOther: async () => false,
      });
      expect(await persistenceQueue.waitForIdle(5_000)).toBe(true);

      const persistedEnvelope = await runtime.service.pool.query(
        `SELECT m.external_message_id, c.title, c.kind
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         WHERE c.provider_account_id = $1
           AND c.external_ref_json LIKE $2
           AND m.external_message_id = $3`,
        [providerAccountId, `%${conversationJid}%`, String(messageId)],
      );
      expect(persistedEnvelope.rows).toHaveLength(1);
      expect(persistedEnvelope.rows[0]).toMatchObject({
        external_message_id: String(messageId),
        title: route.name,
        kind: 'group',
      });

      const contextWindow = await runtime.ops.getRecentTopLevelMessagesBefore(
        conversationJid,
        {
          timestamp: new Date(
            Date.parse(MESSAGE_TIMESTAMP) + 1_000,
          ).toISOString(),
          id: 'after-gh-352-read-all-proof',
        },
        30,
        { providerAccountId },
      );
      expect(contextWindow).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: String(messageId),
            sender,
            content: messageContent,
          }),
        ]),
      );
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

      // Decision 0085: shared persistence rejects this unregistered direct
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
