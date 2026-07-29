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
const EXPECTED_INBOUND_ENVELOPE_STATEMENTS = 28;
const EXPECTED_ENSURE_CONVERSATION_CALLS = 2;

const CONVERSATION_JID = 'tg:-100400100';
const PROVIDER_ACCOUNT_ID = 'telegram_lat_4a_baseline';
const MESSAGE_TIMESTAMP = '2026-07-29T00:00:00.000Z';

describe.runIf(hasPostgresIntegrationDatabase)(
  'inbound envelope Postgres statement baseline',
  () => {
    let runtime: PostgresIntegrationRuntime;

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

    it('measures one inbound envelope through the paired Telegram ingress', async () => {
      const route: ConversationRoute = {
        name: 'Latency Baseline',
        folder: 'main_agent',
        trigger: '@Main',
        added_at: MESSAGE_TIMESTAMP,
        agentId: DEFAULT_AGENT_ID,
        providerAccountId: PROVIDER_ACCOUNT_ID,
        requiresTrigger: true,
        conversationKind: 'channel',
      };
      const app = {
        getConversationRoutes: () => ({ [CONVERSATION_JID]: route }),
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
      const telegramOpts: ChannelOpts = {
        providerAccountId: PROVIDER_ACCOUNT_ID,
        onChatMetadata: handlers.onChatMetadata,
        onMessage: handlers.onMessage,
        conversationRoutes: () => app.getConversationRoutes(),
      };
      const telegramContext = {
        chat: {
          id: -100400100,
          type: 'supergroup',
          title: 'Latency Baseline',
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

      // The message carries the '@Main' trigger the route requires, so this
      // unambiguously exercises the eligible-admission path the baseline
      // claims. Measured both ways: the count is 28 with or without the
      // trigger, because the trigger gates whether the AGENT runs, not whether
      // the message and its admission persist. Keeping it triggered removes
      // the ambiguity rather than relying on that equivalence.
      // This spy wraps and calls through to the real graph method, so both
      // invocations still execute their SQL against the isolated Postgres schema.
      const ensureConversation = vi.spyOn(
        PostgresCanonicalGraphRepository.prototype,
        'ensureConversation',
      );

      // The production ingress dispatches both handlers onto an AsyncTaskQueue,
      // so the measurement window MUST stay open until that queue drains.
      // Closing it when the ingress promise resolves would count only the SQL
      // that happened to have run by then — a racy number that could equal 28
      // by luck. Awaiting idleness INSIDE the measured callback is what makes
      // this a measurement rather than a sample.
      const measurement = await measurePostgresOperations(
        runtime.service.pool,
        async () => {
          await handleTelegramTextMessage({
            ctx: telegramContext,
            opts: telegramOpts,
            assistantName: 'Main',
            triggerPattern: /@Main\b/i,
            tryResolveOther: async () => false,
          });
          expect(await persistenceQueue.waitForIdle(5_000)).toBe(true);
        },
      );
      const observedStatements = measurement.counts.postgres_statements;

      expect(observedStatements).toBe(EXPECTED_INBOUND_ENVELOPE_STATEMENTS);
      expect(ensureConversation).toHaveBeenCalledTimes(
        EXPECTED_ENSURE_CONVERSATION_CALLS,
      );
    });
  },
);
