import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { AppId } from '@core/domain/app/app.js';
import type {
  ConversationId,
  ConversationThreadId,
} from '@core/domain/conversation/conversation.js';
import type {
  ProviderAccountId,
  ProviderId,
} from '@core/domain/provider/provider.js';
import type { NewMessage } from '@core/domain/types.js';
import { buildGroupTurnConversationContext } from '@core/runtime/group-conversation-context.js';
import type { GroupProcessingDeps } from '@core/runtime/group-processing-types.js';
import {
  DEFAULT_AGENT_ID,
  DEFAULT_APP_ID,
} from '@core/adapters/storage/postgres/seeds.js';
import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';
import { measurePostgresOperations } from '../harness/response-latency-postgres.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

maybeDescribe('conversation history coverage Postgres repository', () => {
  let runtime: PostgresIntegrationRuntime;
  const appId = DEFAULT_APP_ID as AppId;
  const providerId = 'slack' as ProviderId;
  const providerAccountId =
    'channel-providerAccount:history-coverage:slack' as ProviderAccountId;
  const reboundProviderAccountId =
    'channel-providerAccount:history-coverage:slack-rebound' as ProviderAccountId;
  const conversationId =
    'conversation:history-coverage:slack:C123' as ConversationId;
  const packetConversationId =
    'conversation:history-coverage:slack:packet' as ConversationId;
  const threadId =
    'thread:history-coverage:slack:C123:1700.1' as ConversationThreadId;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'history_coverage',
    });
    const now = '2026-07-31T00:00:00.000Z';
    await runtime.repositories.providerAccounts.saveProviderAccount({
      id: providerAccountId,
      appId,
      agentId: DEFAULT_AGENT_ID as never,
      providerId,
      externalIdentityRef: { kind: 'provider_account', value: 'T123' },
      label: 'History coverage Slack',
      status: 'active',
      config: {},
      runtimeSecretRefs: {},
      createdAt: now,
      updatedAt: now,
    });
    await runtime.repositories.providerAccounts.saveProviderAccount({
      id: reboundProviderAccountId,
      appId,
      agentId: DEFAULT_AGENT_ID as never,
      providerId,
      externalIdentityRef: { kind: 'provider_account', value: 'T456' },
      label: 'History coverage Slack rebound',
      status: 'active',
      config: {},
      runtimeSecretRefs: {},
      createdAt: now,
      updatedAt: now,
    });
    await runtime.repositories.conversations.saveConversation({
      id: conversationId,
      appId,
      providerAccountId,
      externalRef: { kind: 'conversation', value: 'C123' },
      kind: 'channel',
      title: 'history coverage',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await runtime.repositories.conversations.saveConversation({
      id: packetConversationId,
      appId,
      providerAccountId,
      externalRef: { kind: 'conversation', value: 'C-packet' },
      kind: 'channel',
      title: 'history coverage packet',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
    await runtime.repositories.conversations.saveThread({
      id: threadId,
      appId,
      conversationId,
      externalRef: { kind: 'conversation_thread', value: '1700.1' },
      title: 'history coverage thread',
      status: 'active',
      createdAt: now,
      updatedAt: now,
    });
  }, 60_000);

  afterAll(async () => {
    await runtime?.cleanup();
  });

  it('round-trips unique channel and thread scopes', async () => {
    const repository = runtime.repositories.conversationHistoryCoverage;
    const generation =
      await repository.bumpProviderGeneration(providerAccountId);
    const first = await repository.upsertCoverage({
      providerAccountId,
      conversationId,
      scope: { kind: 'channel' },
      complete: true,
      coveredThroughExternalId: 'message-10',
      coveredThroughTimestamp: '2026-07-31T00:00:10.000Z',
      providerGeneration: generation,
      recordedAt: '2026-07-31T00:00:11.000Z',
      updatedAt: '2026-07-31T00:00:11.000Z',
    });
    expect(first.status).toBe('written');

    await repository.upsertCoverage({
      providerAccountId,
      conversationId,
      scope: { kind: 'channel' },
      complete: false,
      providerGeneration: generation,
      recordedAt: '2026-07-31T00:00:12.000Z',
      updatedAt: '2026-07-31T00:00:12.000Z',
    });
    await repository.upsertCoverage({
      providerAccountId,
      conversationId,
      scope: { kind: 'thread', id: '1700.1' },
      complete: true,
      providerGeneration: generation,
      recordedAt: '2026-07-31T00:00:13.000Z',
      updatedAt: '2026-07-31T00:00:13.000Z',
    });
    await repository.upsertCoverage({
      providerAccountId,
      conversationId,
      scope: { kind: 'thread', id: '' },
      complete: true,
      coveredThroughExternalId: '',
      providerGeneration: generation,
      recordedAt: '2026-07-31T00:00:14.000Z',
      updatedAt: '2026-07-31T00:00:14.000Z',
    });

    await expect(
      repository.getCoverage({
        providerAccountId,
        conversationId,
        scope: { kind: 'channel' },
      }),
    ).resolves.toMatchObject({
      coverage: {
        providerAccountId,
        complete: false,
        providerGeneration: generation,
        scope: { kind: 'channel' },
      },
      currentProviderGeneration: generation,
      isCurrentGeneration: true,
    });
    await expect(
      repository.getCoverage({
        providerAccountId,
        conversationId,
        scope: { kind: 'thread', id: '1700.1' },
      }),
    ).resolves.toMatchObject({
      coverage: {
        complete: true,
        scope: { kind: 'thread', id: '1700.1' },
      },
      isCurrentGeneration: true,
    });
    await expect(
      repository.getCoverage({
        providerAccountId,
        conversationId,
        scope: { kind: 'thread', id: '' },
      }),
    ).resolves.toMatchObject({
      coverage: {
        coveredThroughExternalId: '',
        scope: { kind: 'thread', id: '' },
      },
      isCurrentGeneration: true,
    });

    const rows = await runtime.service.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM conversation_history_coverage WHERE conversation_id = $1',
      [conversationId],
    );
    expect(rows.rows[0]?.count).toBe('3');
  });

  it('lets only a current-generation writer win under concurrency', async () => {
    const repository = runtime.repositories.conversationHistoryCoverage;
    const staleGeneration =
      await repository.readProviderGeneration(providerAccountId);
    const currentGeneration =
      await repository.bumpProviderGeneration(providerAccountId);

    const [stale, current] = await Promise.all([
      repository.upsertCoverage({
        providerAccountId,
        conversationId,
        scope: { kind: 'thread', id: 'concurrent-thread' },
        complete: false,
        providerGeneration: staleGeneration,
        recordedAt: '2026-07-31T00:01:00.000Z',
        updatedAt: '2026-07-31T00:01:00.000Z',
      }),
      repository.upsertCoverage({
        providerAccountId,
        conversationId,
        scope: { kind: 'thread', id: 'concurrent-thread' },
        complete: true,
        coveredThroughExternalId: 'current-message',
        providerGeneration: currentGeneration,
        recordedAt: '2026-07-31T00:01:01.000Z',
        updatedAt: '2026-07-31T00:01:01.000Z',
      }),
    ]);

    expect(stale).toEqual({
      status: 'stale',
      currentGeneration,
    });
    expect(current.status).toBe('written');
    await expect(
      repository.getCoverage({
        providerAccountId,
        conversationId,
        scope: { kind: 'thread', id: 'concurrent-thread' },
      }),
    ).resolves.toMatchObject({
      coverage: {
        complete: true,
        coveredThroughExternalId: 'current-message',
        providerGeneration: currentGeneration,
      },
      currentProviderGeneration: currentGeneration,
      isCurrentGeneration: true,
    });

    const rows = await runtime.service.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM conversation_history_coverage WHERE conversation_id = $1 AND scope_kind = $2 AND scope_id = $3',
      [conversationId, 'thread', 'concurrent-thread'],
    );
    expect(rows.rows[0]?.count).toBe('1');
  });

  it('orders same-generation attestations asymmetrically', async () => {
    const repository = runtime.repositories.conversationHistoryCoverage;
    const generation =
      await repository.readProviderGeneration(providerAccountId);
    const scope = { kind: 'thread' as const, id: 'ordered-boundary-thread' };

    await repository.upsertCoverage({
      providerAccountId,
      conversationId,
      scope,
      complete: false,
      coveredThroughExternalId: 'newer-message',
      coveredThroughTimestamp: '2026-07-31T00:03:00.000Z',
      providerGeneration: generation,
      recordedAt: '2026-07-31T00:03:01.000Z',
      updatedAt: '2026-07-31T00:03:01.000Z',
    });
    await repository.upsertCoverage({
      providerAccountId,
      conversationId,
      scope,
      complete: true,
      coveredThroughExternalId: 'older-message',
      coveredThroughTimestamp: '2026-07-31T00:02:00.000Z',
      providerGeneration: generation,
      recordedAt: '2026-07-31T00:03:02.000Z',
      updatedAt: '2026-07-31T00:03:02.000Z',
    });

    await expect(
      repository.getCoverage({
        providerAccountId,
        conversationId,
        scope,
      }),
    ).resolves.toMatchObject({
      coverage: {
        complete: false,
        coveredThroughExternalId: 'newer-message',
        coveredThroughTimestamp: '2026-07-31T00:03:00.000Z',
        providerGeneration: generation,
      },
      isCurrentGeneration: true,
    });

    const contradictionScope = {
      kind: 'thread' as const,
      id: 'boundary-less-contradiction-thread',
    };
    await repository.upsertCoverage({
      providerAccountId,
      conversationId,
      scope: contradictionScope,
      complete: true,
      coveredThroughExternalId: 'newest-message',
      coveredThroughTimestamp: '2026-07-31T00:04:00.000Z',
      providerGeneration: generation,
      recordedAt: '2026-07-31T00:04:01.000Z',
      updatedAt: '2026-07-31T00:04:01.000Z',
    });
    await repository.upsertCoverage({
      providerAccountId,
      conversationId,
      scope: contradictionScope,
      complete: false,
      providerGeneration: generation,
      recordedAt: '2026-07-31T00:04:02.000Z',
      updatedAt: '2026-07-31T00:04:02.000Z',
    });

    const contradiction = await repository.getCoverage({
      providerAccountId,
      conversationId,
      scope: contradictionScope,
    });
    expect(contradiction).toMatchObject({
      coverage: {
        complete: false,
        providerGeneration: generation,
      },
      isCurrentGeneration: true,
    });
    expect(contradiction.coverage?.coveredThroughExternalId).toBeUndefined();
    expect(contradiction.coverage?.coveredThroughTimestamp).toBeUndefined();
  });

  it('requires the same external id to re-attest an equal timestamp', async () => {
    const repository = runtime.repositories.conversationHistoryCoverage;
    const generation =
      await repository.readProviderGeneration(providerAccountId);
    const timestamp = '2026-07-31T00:05:00.000Z';
    const staleScope = {
      kind: 'thread' as const,
      id: 'equal-timestamp-stale-thread',
    };

    await repository.upsertCoverage({
      providerAccountId,
      conversationId,
      scope: staleScope,
      complete: false,
      coveredThroughExternalId: 'message-b',
      coveredThroughTimestamp: timestamp,
      providerGeneration: generation,
      recordedAt: '2026-07-31T00:05:01.000Z',
      updatedAt: '2026-07-31T00:05:01.000Z',
    });
    await repository.upsertCoverage({
      providerAccountId,
      conversationId,
      scope: staleScope,
      complete: true,
      coveredThroughExternalId: 'message-a',
      coveredThroughTimestamp: timestamp,
      providerGeneration: generation,
      recordedAt: '2026-07-31T00:05:02.000Z',
      updatedAt: '2026-07-31T00:05:02.000Z',
    });

    await expect(
      repository.getCoverage({
        providerAccountId,
        conversationId,
        scope: staleScope,
      }),
    ).resolves.toMatchObject({
      coverage: {
        complete: false,
        coveredThroughExternalId: 'message-b',
        coveredThroughTimestamp: timestamp,
        providerGeneration: generation,
      },
      isCurrentGeneration: true,
    });

    const reattestationScope = {
      kind: 'thread' as const,
      id: 'equal-timestamp-reattestation-thread',
    };
    await repository.upsertCoverage({
      providerAccountId,
      conversationId,
      scope: reattestationScope,
      complete: false,
      coveredThroughExternalId: 'message-b',
      coveredThroughTimestamp: timestamp,
      providerGeneration: generation,
      recordedAt: '2026-07-31T00:05:03.000Z',
      updatedAt: '2026-07-31T00:05:03.000Z',
    });
    await repository.upsertCoverage({
      providerAccountId,
      conversationId,
      scope: reattestationScope,
      complete: true,
      coveredThroughExternalId: 'message-b',
      coveredThroughTimestamp: timestamp,
      providerGeneration: generation,
      recordedAt: '2026-07-31T00:05:04.000Z',
      updatedAt: '2026-07-31T00:05:04.000Z',
    });

    await expect(
      repository.getCoverage({
        providerAccountId,
        conversationId,
        scope: reattestationScope,
      }),
    ).resolves.toMatchObject({
      coverage: {
        complete: true,
        coveredThroughExternalId: 'message-b',
        coveredThroughTimestamp: timestamp,
        providerGeneration: generation,
      },
      isCurrentGeneration: true,
    });
  });

  it('does not expose an old account row after a conversation rebind', async () => {
    const repository = runtime.repositories.conversationHistoryCoverage;
    const generation =
      await repository.readProviderGeneration(providerAccountId);
    await repository.upsertCoverage({
      providerAccountId,
      conversationId,
      scope: { kind: 'thread', id: 'rebound-thread' },
      complete: true,
      providerGeneration: generation,
      recordedAt: '2026-07-31T00:02:00.000Z',
      updatedAt: '2026-07-31T00:02:00.000Z',
    });

    await runtime.repositories.conversations.saveConversation({
      id: conversationId,
      appId,
      providerAccountId: reboundProviderAccountId,
      externalRef: { kind: 'conversation', value: 'C123' },
      kind: 'channel',
      title: 'history coverage rebound',
      status: 'active',
      createdAt: '2026-07-31T00:00:00.000Z',
      updatedAt: '2026-07-31T00:02:01.000Z',
    });

    await expect(
      repository.getCoverage({
        providerAccountId: reboundProviderAccountId,
        conversationId,
        scope: { kind: 'thread', id: 'rebound-thread' },
      }),
    ).resolves.toMatchObject({
      coverage: null,
      isCurrentGeneration: false,
    });

    const afterRebind = await runtime.service.pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM conversation_history_coverage WHERE conversation_id = $1',
      [conversationId],
    );
    expect(afterRebind.rows[0]?.count).toBe('0');

    await runtime.repositories.conversations.saveConversation({
      id: conversationId,
      appId,
      providerAccountId,
      externalRef: { kind: 'conversation', value: 'C123' },
      kind: 'channel',
      title: 'history coverage rebound back',
      status: 'active',
      createdAt: '2026-07-31T00:00:00.000Z',
      updatedAt: '2026-07-31T00:02:02.000Z',
    });

    await expect(
      repository.getCoverage({
        providerAccountId,
        conversationId,
        scope: { kind: 'thread', id: 'rebound-thread' },
      }),
    ).resolves.toMatchObject({
      coverage: null,
      isCurrentGeneration: false,
    });
  });

  it('marks a coverage row stale in the same generation-aware lookup', async () => {
    const repository = runtime.repositories.conversationHistoryCoverage;
    const generation =
      await repository.readProviderGeneration(providerAccountId);
    await repository.upsertCoverage({
      providerAccountId,
      conversationId,
      scope: { kind: 'thread', id: 'generation-aware-read' },
      complete: true,
      providerGeneration: generation,
      recordedAt: '2026-07-31T00:02:03.000Z',
      updatedAt: '2026-07-31T00:02:03.000Z',
    });

    await expect(
      repository.getCoverage({
        providerAccountId,
        conversationId,
        scope: { kind: 'thread', id: 'generation-aware-read' },
      }),
    ).resolves.toMatchObject({
      coverage: { providerGeneration: generation, complete: true },
      currentProviderGeneration: generation,
      isCurrentGeneration: true,
    });

    const bumpedGeneration =
      await repository.bumpProviderGeneration(providerAccountId);
    await expect(
      repository.getCoverage({
        providerAccountId,
        conversationId,
        scope: { kind: 'thread', id: 'generation-aware-read' },
      }),
    ).resolves.toMatchObject({
      coverage: { providerGeneration: generation, complete: true },
      currentProviderGeneration: bumpedGeneration,
      isCurrentGeneration: false,
    });
  });

  it('adds one guard statement and rehydrates exactly once after a generation bump', async () => {
    const repository = runtime.repositories.conversationHistoryCoverage;
    const currentMessage: NewMessage = {
      id: 'packet-current',
      chat_jid: 'sl:C-packet',
      sender: 'U123',
      sender_name: 'History User',
      content: '@Gantry prove durable history coverage',
      timestamp: '2026-08-01T00:00:00.000Z',
      external_message_id: '1754006400.000000',
      provider: 'slack',
      providerAccountId,
      is_from_me: false,
      is_bot_message: false,
    };
    const hydrateConversationContext = vi.fn().mockResolvedValue({
      providerId: 'slack',
      attempted: true,
      messages: [],
      coverage: {
        requestedLatestMessage: {
          externalMessageId: currentMessage.external_message_id,
          timestamp: currentMessage.timestamp,
        },
        scope: 'channel',
        requests: [],
        completeness: { kind: 'server_confirmed', exhausted: true },
        deliveredMessageCount: 0,
        threadRoot: 'not_applicable',
      },
    });
    const packetInput = (historyCoverage: boolean) => ({
      deps: {
        channelRuntime: { hydrateConversationContext },
        getHistoryCoverageDistrustEpoch: () => ({ current: 0, durable: 0 }),
        ...(historyCoverage
          ? { getConversationHistoryCoverageRepository: () => repository }
          : {}),
      } as unknown as GroupProcessingDeps,
      repository: runtime.ops,
      agentFolder: 'main',
      chatJid: currentMessage.chat_jid,
      conversationId: packetConversationId,
      providerAccountId,
      activeThreadId: null,
      latestMessage: currentMessage,
      currentMessages: [currentMessage],
      timezone: 'UTC',
    });

    const beforeGuard = await measurePostgresOperations(
      runtime.service.pool,
      async () => buildGroupTurnConversationContext(packetInput(false)),
    );
    expect(beforeGuard.counts).toEqual({
      postgres_statements: 1,
      postgres_transactions: 0,
    });
    expect(hydrateConversationContext).toHaveBeenCalledTimes(1);

    const generation =
      await repository.readProviderGeneration(providerAccountId);
    await repository.upsertCoverage({
      providerAccountId,
      conversationId: packetConversationId,
      scope: { kind: 'channel' },
      complete: true,
      coveredThroughExternalId: currentMessage.external_message_id,
      coveredThroughTimestamp: currentMessage.timestamp,
      providerGeneration: generation,
      recordedAt: '2026-08-01T00:00:01.000Z',
      updatedAt: '2026-08-01T00:00:01.000Z',
    });
    hydrateConversationContext.mockClear();

    const guarded = await measurePostgresOperations(
      runtime.service.pool,
      async () => buildGroupTurnConversationContext(packetInput(true)),
    );
    expect(guarded.counts).toEqual({
      postgres_statements: 2,
      postgres_transactions: 0,
    });
    expect(hydrateConversationContext).not.toHaveBeenCalled();

    const bumpedGeneration =
      await repository.bumpProviderGeneration(providerAccountId);
    await buildGroupTurnConversationContext(packetInput(true));
    expect(hydrateConversationContext).toHaveBeenCalledTimes(1);
    await expect(
      repository.getCoverage({
        providerAccountId,
        conversationId: packetConversationId,
        scope: { kind: 'channel' },
      }),
    ).resolves.toMatchObject({
      coverage: {
        complete: true,
        providerGeneration: bumpedGeneration,
      },
      currentProviderGeneration: bumpedGeneration,
      isCurrentGeneration: true,
    });

    const reattested = await measurePostgresOperations(
      runtime.service.pool,
      async () => buildGroupTurnConversationContext(packetInput(true)),
    );
    expect(reattested.counts).toEqual(guarded.counts);
    expect(hydrateConversationContext).toHaveBeenCalledTimes(1);
  });

  it('fences a concurrent attestation against conversation rebinding', async () => {
    const repository = runtime.repositories.conversationHistoryCoverage;
    const concurrentConversationId =
      'conversation:history-coverage:slack:concurrent-rebind' as ConversationId;
    await runtime.repositories.conversations.saveConversation({
      id: concurrentConversationId,
      appId,
      providerAccountId,
      externalRef: { kind: 'conversation', value: 'concurrent-rebind' },
      kind: 'channel',
      title: 'concurrent rebind',
      status: 'active',
      createdAt: '2026-07-31T00:03:00.000Z',
      updatedAt: '2026-07-31T00:03:00.000Z',
    });
    const generation =
      await repository.readProviderGeneration(providerAccountId);

    const [attestation, rebind] = await Promise.allSettled([
      repository.upsertCoverage({
        providerAccountId,
        conversationId: concurrentConversationId,
        scope: { kind: 'channel' },
        complete: true,
        providerGeneration: generation,
        recordedAt: '2026-07-31T00:03:01.000Z',
        updatedAt: '2026-07-31T00:03:01.000Z',
      }),
      runtime.repositories.conversations.saveConversation({
        id: concurrentConversationId,
        appId,
        providerAccountId: reboundProviderAccountId,
        externalRef: { kind: 'conversation', value: 'concurrent-rebind' },
        kind: 'channel',
        title: 'concurrent rebind complete',
        status: 'active',
        createdAt: '2026-07-31T00:03:00.000Z',
        updatedAt: '2026-07-31T00:03:02.000Z',
      }),
    ]);

    expect(rebind.status).toBe('fulfilled');
    if (attestation.status === 'rejected') {
      expect(attestation.reason).toMatchObject({
        message: expect.stringContaining('is not owned by Provider Account'),
      });
    } else {
      expect(attestation.value.status).toBe('written');
    }
    const committed = await runtime.service.pool.query<{
      provider_account_id: string;
      coverage_count: string;
    }>(
      `SELECT c.provider_account_id,
              count(h.conversation_id)::text AS coverage_count
         FROM conversations c
         LEFT JOIN conversation_history_coverage h
           ON h.conversation_id = c.id
        WHERE c.id = $1
        GROUP BY c.provider_account_id`,
      [concurrentConversationId],
    );
    expect(committed.rows).toEqual([
      {
        provider_account_id: reboundProviderAccountId,
        coverage_count: '0',
      },
    ]);
  });

  it('serializes concurrent first saves before checking ownership', async () => {
    const repository = runtime.repositories.conversationHistoryCoverage;
    const firstSaveConversationId =
      'conversation:history-coverage:slack:first-save-race' as ConversationId;
    const triggerName = 'history_coverage_first_save_race';
    await runtime.service.pool.query(`
      CREATE SEQUENCE ${triggerName}_entered;
      CREATE OR REPLACE FUNCTION ${triggerName}() RETURNS trigger AS $$
      BEGIN
        IF NEW.id = '${firstSaveConversationId}' THEN
          IF NEW.provider_account_id = '${providerAccountId}' THEN
            PERFORM nextval('${triggerName}_entered');
            PERFORM pg_sleep(0.5);
          ELSE
            PERFORM pg_sleep(0.8);
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER ${triggerName}
      BEFORE INSERT OR UPDATE ON conversations
      FOR EACH ROW EXECUTE FUNCTION ${triggerName}();
    `);

    const conversation = (accountId: ProviderAccountId, updatedAt: string) => ({
      id: firstSaveConversationId,
      appId,
      providerAccountId: accountId,
      externalRef: { kind: 'conversation' as const, value: 'first-save-race' },
      kind: 'channel' as const,
      title: 'first save race',
      status: 'active' as const,
      createdAt: '2026-07-31T00:04:00.000Z',
      updatedAt,
    });

    const firstSave = runtime.repositories.conversations.saveConversation(
      conversation(providerAccountId, '2026-07-31T00:04:00.000Z'),
    );
    await vi.waitFor(
      async () => {
        const entered = await runtime.service.pool.query<{
          is_called: boolean;
        }>(`SELECT is_called FROM ${triggerName}_entered`);
        expect(entered.rows[0]?.is_called).toBe(true);
      },
      { timeout: 2_000, interval: 10 },
    );
    const reboundSave = runtime.repositories.conversations.saveConversation(
      conversation(reboundProviderAccountId, '2026-07-31T00:04:01.000Z'),
    );
    await firstSave;

    const generation =
      await repository.readProviderGeneration(providerAccountId);
    const attestation = repository.upsertCoverage({
      providerAccountId,
      conversationId: firstSaveConversationId,
      scope: { kind: 'channel' },
      complete: true,
      providerGeneration: generation,
      recordedAt: '2026-07-31T00:04:00.500Z',
      updatedAt: '2026-07-31T00:04:00.500Z',
    });

    const [reboundResult, attestationResult] = await Promise.allSettled([
      reboundSave,
      attestation,
    ]);
    expect(reboundResult.status).toBe('fulfilled');
    expect(attestationResult.status).toBe('rejected');
    if (attestationResult.status === 'rejected') {
      expect(attestationResult.reason).toMatchObject({
        message: expect.stringContaining('is not owned by Provider Account'),
      });
    }

    const committed = await runtime.service.pool.query<{
      provider_account_id: string;
      coverage_count: string;
    }>(
      `SELECT c.provider_account_id,
              count(h.conversation_id)::text AS coverage_count
         FROM conversations c
         LEFT JOIN conversation_history_coverage h
           ON h.conversation_id = c.id
        WHERE c.id = $1
        GROUP BY c.provider_account_id`,
      [firstSaveConversationId],
    );
    expect(committed.rows).toEqual([
      {
        provider_account_id: reboundProviderAccountId,
        coverage_count: '0',
      },
    ]);
  });
});
