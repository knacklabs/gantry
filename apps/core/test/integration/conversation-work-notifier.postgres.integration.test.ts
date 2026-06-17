import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PostgresConversationWorkNotifier } from '@core/adapters/storage/postgres/conversation-work-notifier.postgres.js';
import type { ConversationWorkNotificationInput } from '@core/domain/ports/conversation-work-notifier.js';
import { startConversationWorkDispatcher } from '@core/runtime/conversation-work-dispatcher.js';
import {
  findPendingMessageWorkCandidates,
  startConversationWorkReconciler,
} from '@core/runtime/conversation-work-reconciler.js';

import {
  createPostgresIntegrationRuntime,
  hasPostgresIntegrationDatabase,
  type PostgresIntegrationRuntime,
} from '../harness/postgres-integration-runtime.js';

const maybeDescribe = hasPostgresIntegrationDatabase ? describe : describe.skip;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function publishUntilReceived(input: {
  notify: () => Promise<void>;
  received: () => boolean;
  attempts?: number;
}): Promise<void> {
  const attempts = input.attempts ?? 10;
  for (let i = 0; i < attempts; i += 1) {
    await input.notify();
    for (let wait = 0; wait < 10; wait += 1) {
      if (input.received()) return;
      await sleep(20);
    }
  }
  throw new Error('conversation work notification was not delivered');
}

maybeDescribe('PostgresConversationWorkNotifier integration', () => {
  let runtime: PostgresIntegrationRuntime;

  beforeAll(async () => {
    runtime = await createPostgresIntegrationRuntime({
      schemaPrefix: 'conversation_work_notifier',
    });
  }, 60_000);

  afterAll(async () => {
    await runtime?.storageRuntime.conversationWorkNotifier.close();
    await runtime?.cleanup();
  });

  it('delivers sanitized conversation work notifications through real LISTEN/NOTIFY', async () => {
    const notifier = runtime.storageRuntime.conversationWorkNotifier;
    const notifications: unknown[] = [];
    const unsubscribe = notifier.subscribe((notification) => {
      notifications.push(notification);
    });
    const notification: ConversationWorkNotificationInput = {
      appId: 'app:default',
      conversationId: 'wa:918097570021',
      threadId: 'thread-1',
      messageId: 'message:wa:918097570021:provider-1',
      ownerInstanceId: 'server-a',
      leaseVersion: 7,
      leaseExpiresAt: '2026-06-17T10:15:00.000Z',
    };

    await publishUntilReceived({
      notify: () => notifier.notify(notification),
      received: () =>
        notifications.some(
          (received) =>
            typeof received === 'object' &&
            received !== null &&
            'messageId' in received &&
            received.messageId === notification.messageId,
        ),
    });

    expect(notifications).toContainEqual({
      appId: 'app:default',
      conversationId: 'wa:918097570021',
      threadId: 'thread-1',
      messageId: 'message:wa:918097570021:provider-1',
      ownerInstanceId: 'server-a',
      leaseVersion: 7,
      leaseExpiresAt: '2026-06-17T10:15:00.000Z',
    });
    expect(JSON.stringify(notifications)).not.toContain('customer text');

    unsubscribe();
    notifications.length = 0;
    await notifier.notify({
      ...notification,
      messageId: 'message:wa:918097570021:provider-after-unsubscribe',
    });
    await sleep(100);

    expect(notifications).toEqual([]);
  });

  it('lets only the current owner enqueue work across two dispatcher instances', async () => {
    const conversationId = 'wa:918097570031';
    await runtime.ops.storeMessage({
      id: 'conversation-work-dispatcher-message-1',
      chat_jid: conversationId,
      provider: 'interakt',
      sender: '918097570031',
      sender_name: 'Dispatcher Customer',
      content: 'customer text must not enter the wakeup payload',
      timestamp: '2026-06-17T10:20:00.000Z',
      is_from_me: false,
      is_bot_message: false,
      thread_id: null,
    });

    const repository = runtime.storageRuntime.conversationOwnerLeases;
    const notifierA = new PostgresConversationWorkNotifier(
      runtime.service.pool,
    );
    const notifierB = new PostgresConversationWorkNotifier(
      runtime.service.pool,
    );
    const enqueuedA: string[] = [];
    const enqueuedB: string[] = [];
    const now = new Date('2026-06-17T10:20:00.000Z');
    const initialClaim = await repository.claimLease({
      appId: 'default',
      conversationId,
      threadId: null,
      ownerInstanceId: 'server-a',
      leaseTtlMs: 45_000,
      now,
      reason: 'integration-current-owner',
    });
    const dispatcherA = startConversationWorkDispatcher({
      instanceId: 'server-a',
      notifier: notifierA,
      claimLease: (input) => repository.claimLease(input),
      leaseTtlMs: 45_000,
      enqueueMessageCheck: (queueKey) => enqueuedA.push(queueKey),
      now: () => now,
    });
    const dispatcherB = startConversationWorkDispatcher({
      instanceId: 'server-b',
      notifier: notifierB,
      claimLease: (input) => repository.claimLease(input),
      leaseTtlMs: 45_000,
      enqueueMessageCheck: (queueKey) => enqueuedB.push(queueKey),
      now: () => now,
    });

    try {
      await publishUntilReceived({
        notify: () =>
          notifierA.notify({
            appId: 'default',
            conversationId,
            threadId: null,
            messageId: 'message:wa:918097570031:provider-owner-hint',
            ownerInstanceId: initialClaim.lease.ownerInstanceId,
            leaseVersion: initialClaim.lease.leaseVersion,
            leaseExpiresAt: initialClaim.lease.leaseExpiresAt,
          }),
        received: () => enqueuedA.length > 0,
      });
      await sleep(100);

      expect(enqueuedA).toContain(conversationId);
      expect(enqueuedB).toEqual([]);
      expect(JSON.stringify([...enqueuedA, ...enqueuedB])).not.toContain(
        'customer text',
      );
    } finally {
      dispatcherA.close();
      dispatcherB.close();
      await notifierA.close();
      await notifierB.close();
    }
  });

  it('lets only one dispatcher enqueue when a wakeup has no owner hint', async () => {
    const conversationId = 'wa:918097570032';
    await runtime.ops.storeMessage({
      id: 'conversation-work-dispatcher-message-2',
      chat_jid: conversationId,
      provider: 'interakt',
      sender: '918097570032',
      sender_name: 'Unclaimed Dispatcher Customer',
      content: 'unclaimed customer text must not enter the wakeup payload',
      timestamp: '2026-06-17T10:21:00.000Z',
      is_from_me: false,
      is_bot_message: false,
      thread_id: null,
    });

    const repository = runtime.storageRuntime.conversationOwnerLeases;
    const notifierA = new PostgresConversationWorkNotifier(
      runtime.service.pool,
    );
    const notifierB = new PostgresConversationWorkNotifier(
      runtime.service.pool,
    );
    const enqueuedA: string[] = [];
    const enqueuedB: string[] = [];
    const now = new Date('2026-06-17T10:21:00.000Z');
    const dispatcherA = startConversationWorkDispatcher({
      instanceId: 'server-a-unclaimed',
      notifier: notifierA,
      claimLease: (input) => repository.claimLease(input),
      leaseTtlMs: 45_000,
      enqueueMessageCheck: (queueKey) => enqueuedA.push(queueKey),
      now: () => now,
    });
    const dispatcherB = startConversationWorkDispatcher({
      instanceId: 'server-b-unclaimed',
      notifier: notifierB,
      claimLease: (input) => repository.claimLease(input),
      leaseTtlMs: 45_000,
      enqueueMessageCheck: (queueKey) => enqueuedB.push(queueKey),
      now: () => now,
    });

    try {
      await publishUntilReceived({
        notify: () =>
          notifierA.notify({
            appId: 'default',
            conversationId,
            threadId: null,
            messageId: 'message:wa:918097570032:provider-unclaimed',
          }),
        received: () => enqueuedA.length + enqueuedB.length > 0,
      });
      await sleep(100);

      expect(
        [enqueuedA.length > 0, enqueuedB.length > 0].filter(Boolean),
      ).toHaveLength(1);
      expect([...enqueuedA, ...enqueuedB]).toContain(conversationId);
      expect(JSON.stringify([...enqueuedA, ...enqueuedB])).not.toContain(
        'unclaimed customer text',
      );
    } finally {
      dispatcherA.close();
      dispatcherB.close();
      await notifierA.close();
      await notifierB.close();
    }
  });

  it('does not resurrect a stale owner hint after another instance takes over', async () => {
    const conversationId = 'wa:918097570034';
    await runtime.ops.storeMessage({
      id: 'conversation-work-dispatcher-message-3',
      chat_jid: conversationId,
      provider: 'interakt',
      sender: '918097570034',
      sender_name: 'Takeover Dispatcher Customer',
      content: 'takeover customer text must not enter the wakeup payload',
      timestamp: '2026-06-17T10:22:30.000Z',
      is_from_me: false,
      is_bot_message: false,
      thread_id: null,
    });

    const repository = runtime.storageRuntime.conversationOwnerLeases;
    const notifierA = new PostgresConversationWorkNotifier(
      runtime.service.pool,
    );
    const notifierB = new PostgresConversationWorkNotifier(
      runtime.service.pool,
    );
    const enqueuedA: string[] = [];
    const enqueuedB: string[] = [];
    const initialNow = new Date('2026-06-17T10:22:30.000Z');
    let dispatchNow = initialNow;
    const staleOwner = await repository.claimLease({
      appId: 'default',
      conversationId,
      threadId: null,
      ownerInstanceId: 'server-stale-hint',
      leaseTtlMs: 1_000,
      now: initialNow,
      reason: 'integration-stale-hint-owner',
    });
    const takeoverNow = new Date('2026-06-17T10:22:32.000Z');
    const currentOwner = await repository.claimLease({
      appId: 'default',
      conversationId,
      threadId: null,
      ownerInstanceId: 'server-current-takeover',
      leaseTtlMs: 45_000,
      now: takeoverNow,
      reason: 'integration-stale-hint-takeover',
    });
    dispatchNow = new Date('2026-06-17T10:22:33.000Z');

    const dispatcherA = startConversationWorkDispatcher({
      instanceId: 'server-stale-hint',
      notifier: notifierA,
      claimLease: (input) => repository.claimLease(input),
      leaseTtlMs: 45_000,
      enqueueMessageCheck: (queueKey) => enqueuedA.push(queueKey),
      now: () => dispatchNow,
    });
    const dispatcherB = startConversationWorkDispatcher({
      instanceId: 'server-current-takeover',
      notifier: notifierB,
      claimLease: (input) => repository.claimLease(input),
      leaseTtlMs: 45_000,
      enqueueMessageCheck: (queueKey) => enqueuedB.push(queueKey),
      now: () => dispatchNow,
    });

    try {
      await publishUntilReceived({
        notify: () =>
          notifierA.notify({
            appId: 'default',
            conversationId,
            threadId: null,
            messageId: 'message:wa:918097570034:provider-stale-hint',
            ownerInstanceId: staleOwner.lease.ownerInstanceId,
            leaseVersion: staleOwner.lease.leaseVersion,
            leaseExpiresAt: staleOwner.lease.leaseExpiresAt,
          }),
        received: () => enqueuedB.length > 0,
      });
      await sleep(100);

      expect(staleOwner.acquired).toBe(true);
      expect(currentOwner.acquired).toBe(true);
      expect(currentOwner.lease.ownerInstanceId).toBe(
        'server-current-takeover',
      );
      expect(enqueuedA).toEqual([]);
      expect(enqueuedB).toEqual([conversationId]);
      expect(JSON.stringify([...enqueuedA, ...enqueuedB])).not.toContain(
        'takeover customer text',
      );
    } finally {
      dispatcherA.close();
      dispatcherB.close();
      await notifierA.close();
      await notifierB.close();
    }
  });

  it('recovers persisted inbound work when the notification callback never runs', async () => {
    const conversationId = 'wa:918097570033';
    await runtime.ops.storeMessage({
      id: 'conversation-work-reconciler-message-1',
      chat_jid: conversationId,
      provider: 'interakt',
      sender: '918097570033',
      sender_name: 'Missed Notification Customer',
      content: 'missed notification customer text must not enter enqueue state',
      timestamp: '2026-06-17T10:22:00.000Z',
      is_from_me: false,
      is_bot_message: false,
      thread_id: null,
    });

    const repository = runtime.storageRuntime.conversationOwnerLeases;
    const enqueued: string[] = [];
    const now = new Date('2026-06-17T10:22:00.000Z');
    const reconciler = startConversationWorkReconciler({
      instanceId: 'server-reconciler-missed',
      leaseTtlMs: 45_000,
      intervalMs: 60_000,
      scanLimit: 10,
      findCandidates: ({ limit }) =>
        findPendingMessageWorkCandidates({
          getConversationRoutes: () => ({
            [conversationId]: {
              name: 'Runtime Smoke',
              folder: 'runtime-smoke',
              trigger: null,
              added_at: '2026-06-17T10:22:00.000Z',
              requiresTrigger: false,
            },
          }),
          getOrRecoverCursor: () => '',
          messageRepository: runtime.ops,
          limit,
        }),
      claimLease: (input) => repository.claimLease(input),
      enqueueMessageCheck: (queueKey) => enqueued.push(queueKey),
      now: () => now,
    });

    try {
      await reconciler.runOnce();

      expect(enqueued).toEqual([conversationId]);
      expect(JSON.stringify(enqueued)).not.toContain(
        'missed notification customer text',
      );
      const competingClaim = await repository.claimLease({
        appId: 'default',
        conversationId,
        threadId: null,
        ownerInstanceId: 'server-reconciler-competitor',
        leaseTtlMs: 45_000,
        now,
        reason: 'missed-notify-competitor',
      });
      expect(competingClaim.acquired).toBe(false);
      expect(competingClaim.lease.ownerInstanceId).toBe(
        'server-reconciler-missed',
      );
    } finally {
      reconciler.close();
    }
  });
});
