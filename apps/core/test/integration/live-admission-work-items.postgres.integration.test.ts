import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { quotePostgresIdentifier } from '@core/adapters/storage/postgres/storage-service.js';
import { RUNTIME_EVENT_TYPES } from '@core/domain/events/runtime-event-types.js';
import { nowMs, toIso } from '@core/shared/time/datetime.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

maybeDescribe('live admission work items (Postgres)', () => {
  let runtime: PostgresIntegrationRuntime;
  let liveTurns: PostgresIntegrationRuntime['repositories']['liveTurns'];

  const base = {
    appId: 'default',
    agentSessionId: 'session-live-admission',
    conversationId: 'tg:live-admission',
    threadId: null,
    queueJid: 'tg:live-admission',
    messageId: 'message:tg:live-admission:msg-1',
    messageCursor: '2026-06-16T00:00:00.000Z::msg-1',
    idempotencyKey: 'telegram:delivery:msg-1',
  };

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'live_admission',
    });
    liveTurns = runtime.repositories.liveTurns;
  });

  afterAll(async () => {
    await runtime?.cleanup();
  });

  it('deduplicates provider delivery by idempotency key', async () => {
    const first = await liveTurns.enqueueLiveAdmissionWorkItem({
      id: 'admission-1',
      ...base,
      triggerDecision: { requiresTrigger: false },
      now: toIso(nowMs() - 10_000),
    });
    expect(first.outcome).toBe('enqueued');
    expect(first.item).toMatchObject({
      id: 'admission-1',
      state: 'queued',
      sourceKind: 'message',
      triggerDecision: { requiresTrigger: false },
    });

    const replay = await liveTurns.enqueueLiveAdmissionWorkItem({
      id: 'admission-duplicate',
      ...base,
    });
    expect(replay.outcome).toBe('replayed');
    expect(replay.item.id).toBe('admission-1');
  });

  it('deduplicates provider delivery by deterministic work item id', async () => {
    const first = await liveTurns.enqueueLiveAdmissionWorkItem({
      id: 'admission-id-replay',
      ...base,
      appId: 'app-id-replay',
      messageId: 'message:tg:live-admission:id-replay',
      messageCursor: '2026-06-16T00:00:00.500Z::id-replay',
      idempotencyKey: 'telegram:delivery:id-replay:root',
      now: toIso(nowMs() - 9_500),
    });
    expect(first.outcome).toBe('enqueued');

    const replay = await liveTurns.enqueueLiveAdmissionWorkItem({
      id: 'admission-id-replay',
      ...base,
      appId: 'app-id-replay',
      messageId: 'message:tg:live-admission:id-replay',
      messageCursor: '2026-06-16T00:00:00.500Z::id-replay',
      idempotencyKey: 'telegram:delivery:id-replay:thread',
    });

    expect(replay.outcome).toBe('replayed');
    expect(replay.item).toMatchObject({
      id: 'admission-id-replay',
      idempotencyKey: 'telegram:delivery:id-replay:root',
    });
  });

  it('claims due rows in durable FIFO order without prompt text payloads', async () => {
    await liveTurns.enqueueLiveAdmissionWorkItem({
      id: 'admission-2',
      ...base,
      messageId: 'message:tg:live-admission:msg-2',
      messageCursor: '2026-06-16T00:00:01.000Z::msg-2',
      idempotencyKey: 'telegram:delivery:msg-2',
      now: toIso(nowMs() - 9_000),
    });

    const claimed = await liveTurns.claimLiveAdmissionWorkItems({
      appId: base.appId,
      workerInstanceId: 'worker-1',
      claimToken: 'claim-token-1',
      claimExpiresAt: toIso(nowMs() + 60_000),
      limit: 10,
    });

    expect(claimed.map((item) => item.id)).toEqual([
      'admission-1',
      'admission-2',
    ]);
    expect(claimed[0]).toMatchObject({
      state: 'claimed',
      claimWorkerInstanceId: 'worker-1',
      claimToken: 'claim-token-1',
      fencingVersion: 1,
      retryCount: 1,
      failureCount: 0,
    });
    expect(JSON.stringify(claimed)).not.toContain('hello');
    await expect(
      liveTurns.settleLiveAdmissionWorkItem({
        id: 'admission-2',
        claimToken: 'claim-token-1',
        workerInstanceId: 'worker-1',
        state: 'completed',
      }),
    ).resolves.toBe(true);
  });

  it('defers capacity-limited claims and reclaims them only when due', async () => {
    const deferred = await liveTurns.deferLiveAdmissionWorkItem({
      id: 'admission-1',
      claimToken: 'claim-token-1',
      workerInstanceId: 'worker-1',
      reason: 'queued_capacity',
      deferUntil: toIso(nowMs() + 60_000),
    });
    expect(deferred).toBe(true);

    await expect(
      liveTurns.claimLiveAdmissionWorkItems({
        appId: base.appId,
        workerInstanceId: 'worker-2',
        claimToken: 'claim-token-2',
        claimExpiresAt: toIso(nowMs() + 60_000),
        limit: 10,
      }),
    ).resolves.toEqual([]);

    const reclaimed = await liveTurns.claimLiveAdmissionWorkItems({
      appId: base.appId,
      workerInstanceId: 'worker-2',
      claimToken: 'claim-token-2',
      claimExpiresAt: toIso(nowMs() + 60_000),
      limit: 10,
      now: toIso(nowMs() + 120_000),
    });

    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]).toMatchObject({
      id: 'admission-1',
      state: 'claimed',
      claimWorkerInstanceId: 'worker-2',
      claimToken: 'claim-token-2',
      deferredReason: null,
      fencingVersion: 2,
      retryCount: 2,
      failureCount: 0,
    });
  });

  it('counts real processing failures separately from claim attempts', async () => {
    await liveTurns.enqueueLiveAdmissionWorkItem({
      id: 'admission-failure-count',
      ...base,
      messageId: 'message:tg:live-admission:failure-count',
      messageCursor: '2026-06-16T00:00:01.500Z::failure-count',
      idempotencyKey: 'telegram:delivery:failure-count',
      now: toIso(nowMs() - 8_000),
    });
    const [claimed] = await liveTurns.claimLiveAdmissionWorkItems({
      appId: base.appId,
      workerInstanceId: 'worker-failure-count',
      claimToken: 'claim-token-failure-count',
      claimExpiresAt: toIso(nowMs() + 60_000),
      limit: 1,
    });
    expect(claimed).toMatchObject({
      id: 'admission-failure-count',
      retryCount: 1,
      failureCount: 0,
    });

    await expect(
      liveTurns.deferLiveAdmissionWorkItem({
        id: 'admission-failure-count',
        claimToken: 'claim-token-failure-count',
        workerInstanceId: 'worker-failure-count',
        reason: 'listener_degraded',
        deferUntil: toIso(nowMs() - 1_000),
        countFailure: true,
      }),
    ).resolves.toBe(true);

    const [reclaimed] = await liveTurns.claimLiveAdmissionWorkItems({
      appId: base.appId,
      workerInstanceId: 'worker-failure-count-reclaim',
      claimToken: 'claim-token-failure-count-reclaim',
      claimExpiresAt: toIso(nowMs() + 60_000),
      limit: 1,
    });
    expect(reclaimed).toMatchObject({
      id: 'admission-failure-count',
      retryCount: 2,
      failureCount: 1,
    });

    await expect(
      liveTurns.settleLiveAdmissionWorkItem({
        id: 'admission-failure-count',
        claimToken: 'claim-token-failure-count-reclaim',
        workerInstanceId: 'worker-failure-count-reclaim',
        state: 'completed',
      }),
    ).resolves.toBe(true);
  });

  it('claims only work items for the requested app scope', async () => {
    await liveTurns.enqueueLiveAdmissionWorkItem({
      id: 'admission-other-app',
      ...base,
      appId: 'app-other',
      messageId: 'message:tg:live-admission:other-app',
      messageCursor: '2026-06-16T00:00:02.000Z::other-app',
      idempotencyKey: 'telegram:delivery:other-app',
      now: toIso(nowMs() - 7_000),
    });

    const claimed = await liveTurns.claimLiveAdmissionWorkItems({
      appId: base.appId,
      workerInstanceId: 'worker-app-scope',
      claimToken: 'claim-token-app-scope',
      claimExpiresAt: toIso(nowMs() + 60_000),
      limit: 10,
    });

    expect(claimed.map((item) => item.id)).not.toContain('admission-other-app');
  });

  it('renews a claim before another worker can reclaim an expired batch row', async () => {
    await liveTurns.enqueueLiveAdmissionWorkItem({
      id: 'admission-renew-expiry',
      ...base,
      messageId: 'message:tg:live-admission:renew-expiry',
      messageCursor: '2026-06-16T00:00:02.500Z::renew-expiry',
      idempotencyKey: 'telegram:delivery:renew-expiry',
      now: toIso(nowMs() - 6_000),
    });
    const first = await liveTurns.claimLiveAdmissionWorkItems({
      appId: base.appId,
      workerInstanceId: 'worker-renew-a',
      claimToken: 'claim-token-renew-a',
      claimExpiresAt: '2026-06-16T00:00:03.000Z',
      limit: 1,
      now: '2026-06-16T00:00:02.000Z',
    });
    expect(first.map((item) => item.id)).toEqual(['admission-renew-expiry']);

    await expect(
      liveTurns.renewLiveAdmissionWorkItemClaim({
        id: 'admission-renew-expiry',
        workerInstanceId: 'worker-renew-a',
        claimToken: 'claim-token-renew-a',
        claimExpiresAt: '2026-06-16T00:01:00.000Z',
        now: '2026-06-16T00:00:02.500Z',
      }),
    ).resolves.toBe(true);
    await expect(
      liveTurns.claimLiveAdmissionWorkItems({
        appId: base.appId,
        workerInstanceId: 'worker-renew-b',
        claimToken: 'claim-token-renew-b',
        claimExpiresAt: '2026-06-16T00:02:00.000Z',
        limit: 1,
        now: '2026-06-16T00:00:04.000Z',
      }),
    ).resolves.toEqual([]);

    await liveTurns.settleLiveAdmissionWorkItem({
      id: 'admission-renew-expiry',
      workerInstanceId: 'worker-renew-a',
      claimToken: 'claim-token-renew-a',
      state: 'completed',
    });
  });

  it('rejects stale settlement and accepts the active claim fence', async () => {
    await expect(
      liveTurns.settleLiveAdmissionWorkItem({
        id: 'admission-1',
        claimToken: 'claim-token-1',
        workerInstanceId: 'worker-1',
        state: 'completed',
      }),
    ).resolves.toBe(false);

    await expect(
      liveTurns.settleLiveAdmissionWorkItem({
        id: 'admission-1',
        claimToken: 'claim-token-2',
        workerInstanceId: 'worker-2',
        state: 'completed',
      }),
    ).resolves.toBe(true);
  });

  it('claims concurrent due rows without duplicate ownership', async () => {
    const createdAt = toIso(nowMs() - 8_000);
    for (const suffix of ['a', 'b']) {
      await liveTurns.enqueueLiveAdmissionWorkItem({
        id: `admission-concurrent-${suffix}`,
        ...base,
        messageId: `message:tg:live-admission:concurrent-${suffix}`,
        messageCursor: `2026-06-16T00:00:03.000Z::concurrent-${suffix}`,
        idempotencyKey: `telegram:delivery:concurrent-${suffix}`,
        now: createdAt,
      });
    }

    const [workerA, workerB] = await Promise.all([
      liveTurns.claimLiveAdmissionWorkItems({
        appId: base.appId,
        workerInstanceId: 'worker-concurrent-a',
        claimToken: 'claim-token-concurrent-a',
        claimExpiresAt: toIso(nowMs() + 60_000),
        limit: 2,
      }),
      liveTurns.claimLiveAdmissionWorkItems({
        appId: base.appId,
        workerInstanceId: 'worker-concurrent-b',
        claimToken: 'claim-token-concurrent-b',
        claimExpiresAt: toIso(nowMs() + 60_000),
        limit: 2,
      }),
    ]);

    const claimed = [...workerA, ...workerB];
    expect(claimed.map((item) => item.id).sort()).toEqual([
      'admission-concurrent-a',
      'admission-concurrent-b',
    ]);
    expect(new Set(claimed.map((item) => item.id)).size).toBe(2);
    for (const item of claimed) {
      await expect(
        liveTurns.settleLiveAdmissionWorkItem({
          id: item.id,
          claimToken: item.claimToken ?? '',
          workerInstanceId: item.claimWorkerInstanceId ?? '',
          state: 'completed',
        }),
      ).resolves.toBe(true);
    }
  });

  it('does not let branch preselection locks hide older concurrent candidates', async () => {
    const createdAt = '2026-06-16T00:00:10.000Z';
    const dueAt = '2000-01-01T00:00:00.000Z';
    const now = '2026-06-16T00:01:00.000Z';
    const ids = [
      'admission-lock-queued',
      'admission-lock-due-1',
      'admission-lock-due-2',
    ];
    for (const [index, id] of ids.entries()) {
      await liveTurns.enqueueLiveAdmissionWorkItem({
        id,
        ...base,
        messageId: `message:tg:live-admission:${id}`,
        messageCursor: `2026-06-16T00:00:10.000Z::${id}`,
        idempotencyKey: `telegram:delivery:${id}`,
        now: toIso(Date.parse(createdAt) + index),
      });
    }
    await runtime.service.pool.query(
      `UPDATE ${quotePostgresIdentifier(
        runtime.schemaName,
      )}.${quotePostgresIdentifier('live_admission_work_items')}
       SET state = 'deferred',
           defer_until = $1,
           deferred_reason = 'retry',
           updated_at = $2
       WHERE id IN ($3, $4)`,
      [dueAt, now, 'admission-lock-due-1', 'admission-lock-due-2'],
    );

    const tableName = `${quotePostgresIdentifier(
      runtime.schemaName,
    )}.${quotePostgresIdentifier('live_admission_work_items')}`;
    const held = await runtime.service.pool.connect();
    try {
      await held.query('BEGIN');
      const first = await held.query<{ id: string }>(
        `WITH queued AS (
           SELECT id, created_at
           FROM ${tableName}
           WHERE state = 'queued'
           ORDER BY created_at ASC, id ASC
           LIMIT $2
         ),
         due_deferred AS (
           SELECT id, created_at
           FROM ${tableName}
           WHERE state = 'deferred'
             AND defer_until <= $1
           ORDER BY defer_until ASC, created_at ASC, id ASC
           LIMIT $2
         ),
         candidates AS (
           SELECT id, created_at FROM queued
           UNION ALL
           SELECT id, created_at FROM due_deferred
         )
         SELECT id
         FROM ${tableName}
         INNER JOIN candidates USING (id)
         WHERE state = 'queued'
           OR (
             state = 'deferred'
             AND defer_until <= $1
           )
         ORDER BY candidates.created_at ASC, candidates.id ASC
         LIMIT $2
         FOR UPDATE SKIP LOCKED`,
        [now, 1],
      );
      expect(first.rows.map((row) => row.id)).toEqual([
        'admission-lock-queued',
      ]);

      const second = await liveTurns.claimLiveAdmissionWorkItems({
        appId: base.appId,
        workerInstanceId: 'worker-lock-probe',
        claimToken: 'claim-token-lock-probe',
        claimExpiresAt: toIso(nowMs() + 60_000),
        limit: 1,
        now,
      });
      expect(second.map((item) => item.id)).toEqual(['admission-lock-due-1']);
    } finally {
      await held.query('ROLLBACK').catch(() => undefined);
      held.release();
      await runtime.service.pool.query(
        `UPDATE ${tableName}
         SET state = 'completed',
             ended_at = $1,
             updated_at = $1
         WHERE id = ANY($2::text[])`,
        [now, ids],
      );
    }
  });

  it('keeps original message order for deferred retries inside the candidate window', async () => {
    const ids = [
      'admission-due-old-later-ready',
      'admission-due-newer-earlier-ready',
    ];
    for (const [index, id] of ids.entries()) {
      await liveTurns.enqueueLiveAdmissionWorkItem({
        id,
        ...base,
        messageId: `message:tg:live-admission:${id}`,
        messageCursor: `2026-06-16T00:00:20.000Z::${id}`,
        idempotencyKey: `telegram:delivery:${id}`,
        now: toIso(Date.parse('2026-06-16T00:00:20.000Z') + index),
      });
    }
    const tableName = `${quotePostgresIdentifier(
      runtime.schemaName,
    )}.${quotePostgresIdentifier('live_admission_work_items')}`;
    await runtime.service.pool.query(
      `UPDATE ${tableName}
       SET state = 'deferred',
           defer_until = CASE
             WHEN id = $1 THEN '2000-01-02T00:00:00.000Z'::timestamptz
             ELSE '2000-01-01T00:00:00.000Z'::timestamptz
           END,
           deferred_reason = 'retry',
           updated_at = '2026-06-16T00:00:30.000Z'::timestamptz
       WHERE id = ANY($2::text[])`,
      [ids[0], ids],
    );

    const claimed = await liveTurns.claimLiveAdmissionWorkItems({
      appId: base.appId,
      workerInstanceId: 'worker-due-order',
      claimToken: 'claim-token-due-order',
      claimExpiresAt: toIso(nowMs() + 60_000),
      limit: 1,
      now: '2001-01-01T00:00:00.000Z',
    });
    expect(claimed.map((item) => item.id)).toEqual([
      'admission-due-old-later-ready',
    ]);

    await runtime.service.pool.query(
      `UPDATE ${tableName}
       SET state = 'completed',
           ended_at = '2026-06-16T00:00:31.000Z'::timestamptz,
           updated_at = '2026-06-16T00:00:31.000Z'::timestamptz
       WHERE id = ANY($1::text[])`,
      [ids],
    );
  });

  it('keeps original message order for expired claims inside the candidate window', async () => {
    const ids = [
      'admission-expired-old-later-expiry',
      'admission-expired-newer-earlier-expiry',
    ];
    for (const [index, id] of ids.entries()) {
      await liveTurns.enqueueLiveAdmissionWorkItem({
        id,
        ...base,
        messageId: `message:tg:live-admission:${id}`,
        messageCursor: `2026-06-16T00:00:40.000Z::${id}`,
        idempotencyKey: `telegram:delivery:${id}`,
        now: toIso(Date.parse('2026-06-16T00:00:40.000Z') + index),
      });
    }
    const tableName = `${quotePostgresIdentifier(
      runtime.schemaName,
    )}.${quotePostgresIdentifier('live_admission_work_items')}`;
    await runtime.service.pool.query(
      `UPDATE ${tableName}
       SET state = 'claimed',
           claim_worker_instance_id = 'stale-worker',
           claim_token = 'stale-token',
           claim_expires_at = CASE
             WHEN id = $1 THEN '2000-01-02T00:00:00.000Z'::timestamptz
             ELSE '2000-01-01T00:00:00.000Z'::timestamptz
           END,
           claimed_at = '2026-06-16T00:00:41.000Z'::timestamptz,
           updated_at = '2026-06-16T00:00:41.000Z'::timestamptz
       WHERE id = ANY($2::text[])`,
      [ids[0], ids],
    );

    const claimed = await liveTurns.claimLiveAdmissionWorkItems({
      appId: base.appId,
      workerInstanceId: 'worker-expired-order',
      claimToken: 'claim-token-expired-order',
      claimExpiresAt: toIso(nowMs() + 60_000),
      limit: 1,
      now: '2001-01-01T00:00:00.000Z',
    });
    expect(claimed.map((item) => item.id)).toEqual([
      'admission-expired-old-later-expiry',
    ]);

    await runtime.service.pool.query(
      `UPDATE ${tableName}
       SET state = 'completed',
           ended_at = '2026-06-16T00:00:42.000Z'::timestamptz,
           updated_at = '2026-06-16T00:00:42.000Z'::timestamptz
       WHERE id = ANY($1::text[])`,
      [ids],
    );
  });

  it('stores an inbound message and live admission work item in one repository call', async () => {
    const message = {
      id: 'msg-atomic-1',
      chat_jid: 'tg:live-admission-atomic',
      provider: 'telegram',
      sender: 'user-atomic',
      sender_name: 'Atomic User',
      content: 'sensitive prompt body',
      timestamp: '2026-06-16T00:00:02.000Z',
      is_from_me: false,
      is_bot_message: false,
    };

    const result = await runtime.ops.storeMessageWithLiveAdmission?.(message, {
      appId: 'default',
      agentId: 'atomic_agent',
      triggerDecision: {
        source: 'channel_persistence',
        requiresTrigger: false,
      },
    });

    expect(result?.outcome).toBe('enqueued');
    expect(result?.item).toMatchObject({
      appId: 'default',
      agentId: 'agent:atomic_agent',
      conversationId: 'tg:live-admission-atomic',
      threadId: null,
      queueJid:
        'tg:live-admission-atomic::agent:agent%3Aatomic_agent::provider_account:channel-providerAccount%3Adefault%3Atelegram',
      messageId:
        'message:channel-providerAccount:default:telegram:tg:live-admission-atomic:msg-atomic-1',
      senderUserId: 'user-atomic',
      senderDisplayName: 'Atomic User',
      state: 'queued',
      triggerDecision: {
        source: 'channel_persistence',
        requiresTrigger: false,
      },
    });
    expect(JSON.stringify(result?.item)).not.toContain('sensitive prompt body');

    await expect(
      runtime.ops.getMessagesSince('tg:live-admission-atomic', '', 10, {
        threadId: null,
      }),
    ).resolves.toMatchObject([
      {
        id: 'msg-atomic-1',
        content: 'sensitive prompt body',
      },
    ]);

    const replay = await runtime.ops.storeMessageWithLiveAdmission?.(message, {
      appId: 'default',
      agentId: 'atomic_agent',
      triggerDecision: {
        source: 'channel_persistence',
        requiresTrigger: false,
      },
    });
    expect(replay?.outcome).toBe('replayed');
    expect(replay?.item.id).toBe(result?.item.id);

    const claimed = await liveTurns.claimLiveAdmissionWorkItems({
      appId: base.appId,
      workerInstanceId: 'worker-no-notify',
      claimToken: 'claim-token-no-notify',
      claimExpiresAt: toIso(nowMs() + 60_000),
      limit: 10,
    });
    expect(claimed.map((item) => item.id)).toContain(result?.item.id);
  });

  it('stores accepted runtime event and live admission atomically', async () => {
    const message = {
      id: 'msg-event-admission-1',
      chat_jid: 'tg:live-admission-event-atomic',
      provider: 'telegram',
      sender: 'user-event-admission',
      sender_name: 'Event Admission User',
      content: 'accepted event and admission body',
      timestamp: '2026-06-16T00:00:03.000Z',
      is_from_me: false,
      is_bot_message: false,
    };

    const result =
      await runtime.storageRuntime.runtimeEvents.publishWithLiveAdmissionMessage(
        {
          appId: 'default' as never,
          eventType: RUNTIME_EVENT_TYPES.SESSION_MESSAGE_INBOUND,
          actor: 'sdk',
          payload: {
            messageId: message.id,
            text: message.content,
          },
          createdAt: message.timestamp,
        },
        {
          message,
          liveAdmission: {
            appId: 'default',
            agentId: 'event_admission_agent',
            triggerDecision: {
              source: 'sdk_session',
            },
            now: message.timestamp,
          },
        },
      );

    expect(result.event).toMatchObject({
      eventType: RUNTIME_EVENT_TYPES.SESSION_MESSAGE_INBOUND,
      payload: {
        messageId: message.id,
        text: message.content,
      },
    });
    expect(result.liveAdmissionResult?.item).toMatchObject({
      state: 'queued',
      messageId:
        'message:channel-providerAccount:default:telegram:tg:live-admission-event-atomic:msg-event-admission-1',
    });
    await expect(
      runtime.ops.getMessagesSince('tg:live-admission-event-atomic', '', 10, {
        threadId: null,
      }),
    ).resolves.toMatchObject([
      {
        id: 'msg-event-admission-1',
        content: 'accepted event and admission body',
      },
    ]);

    const claimed = await liveTurns.claimLiveAdmissionWorkItems({
      appId: base.appId,
      workerInstanceId: 'worker-event-admission',
      claimToken: 'claim-token-event-admission',
      claimExpiresAt: toIso(nowMs() + 60_000),
      limit: 10,
    });
    expect(claimed.map((item) => item.id)).toContain(
      result.liveAdmissionResult?.item.id,
    );
  });
});
