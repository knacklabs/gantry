import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
        workerInstanceId: 'worker-2',
        claimToken: 'claim-token-2',
        claimExpiresAt: toIso(nowMs() + 60_000),
        limit: 10,
      }),
    ).resolves.toEqual([]);

    const reclaimed = await liveTurns.claimLiveAdmissionWorkItems({
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
        workerInstanceId: 'worker-concurrent-a',
        claimToken: 'claim-token-concurrent-a',
        claimExpiresAt: toIso(nowMs() + 60_000),
        limit: 2,
      }),
      liveTurns.claimLiveAdmissionWorkItems({
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
      queueJid: 'tg:live-admission-atomic',
      messageId: 'message:tg:live-admission-atomic:msg-atomic-1',
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
      workerInstanceId: 'worker-no-notify',
      claimToken: 'claim-token-no-notify',
      claimExpiresAt: toIso(nowMs() + 60_000),
      limit: 10,
    });
    expect(claimed.map((item) => item.id)).toContain(result?.item.id);
  });
});
