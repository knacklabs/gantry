import { describe, expect, it, vi } from 'vitest';

import { startLiveAdmissionWorkLoop } from '@core/runtime/live-admission-work-loop.js';
import type { LiveAdmissionWorkItem } from '@core/domain/ports/live-turns.js';
import type { MessageLoopDeps } from '@core/runtime/message-loop.js';

const baseItem: LiveAdmissionWorkItem = {
  id: 'admission-1',
  appId: 'default',
  agentId: null,
  agentSessionId: null,
  conversationId: 'group@g.us',
  threadId: null,
  queueJid: 'group@g.us',
  messageId: 'message:group@g.us:1',
  messageCursor: '2024-01-01T00:00:01.000Z::1',
  senderUserId: 'user@s.whatsapp.net',
  senderDisplayName: 'User',
  idempotencyKey: 'provider:msg-1',
  state: 'claimed',
  sourceKind: 'message',
  triggerDecision: {},
  claimWorkerInstanceId: 'worker-1',
  claimToken: 'claim-1',
  claimExpiresAt: '2024-01-01T00:01:00.000Z',
  fencingVersion: 1,
  retryCount: 1,
  failureCount: 0,
  deferUntil: null,
  deferredReason: null,
  createdAt: '2024-01-01T00:00:01.000Z',
  updatedAt: '2024-01-01T00:00:01.000Z',
  claimedAt: '2024-01-01T00:00:01.000Z',
  endedAt: null,
};

const replayMessage = {
  id: 1,
  chat_jid: 'group@g.us',
  sender: 'user@s.whatsapp.net',
  content: 'hello',
  timestamp: '2024-01-01T00:00:01.000Z',
  is_from_me: false,
  message_id: 'msg-1',
  reply_to_message_id: null,
  reply_to_content: null,
  sender_name: 'User',
};

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function makeDeps(enqueueMessageCheck: () => boolean): MessageLoopDeps {
  return {
    getConversationRoutes: () => ({
      'group@g.us': {
        name: 'Team',
        folder: 'team',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
        requiresTrigger: false,
      },
    }),
    getLastTimestamp: () => '',
    setLastTimestamp: vi.fn(),
    getOrRecoverCursor: () => '',
    setAgentCursor: vi.fn(),
    saveState: vi.fn(),
    hasChannel: () => true,
    setTyping: vi.fn(),
    sendProgressUpdate: vi.fn(),
    queue: {
      sendMessage: vi.fn(() => false),
      enqueueMessageCheck,
      closeStdin: vi.fn(),
    },
    opsRepository: {
      storeMessage: vi.fn(),
      getNewMessages: vi.fn(),
      getMessagesSince: vi.fn(async () => [replayMessage]),
      getMessageThreadIds: vi.fn(),
      getLastBotMessageCursor: vi.fn(),
      getLastBotMessageTimestamp: vi.fn(),
    },
  };
}

describe('startLiveAdmissionWorkLoop', () => {
  it('settles a claimed work item after queue-scoped replay succeeds', async () => {
    const settleLiveAdmissionWorkItem = vi.fn(async () => true);
    const renewLiveAdmissionWorkItemClaim = vi.fn(async () => true);
    const claimLiveAdmissionWorkItems = vi.fn(async () => [baseItem]);
    const loop = startLiveAdmissionWorkLoop({
      liveAdmissions: {
        claimLiveAdmissionWorkItems,
        renewLiveAdmissionWorkItemClaim,
        deferLiveAdmissionWorkItem: vi.fn(),
        settleLiveAdmissionWorkItem,
        enqueueLiveAdmissionWorkItem: vi.fn(),
      },
      appId: 'default',
      workerInstanceId: 'worker-1',
      messageLoopDeps: makeDeps(() => true),
      intervalMs: 60_000,
      maxBatchesPerWake: 1,
      warn: vi.fn(),
    });

    await vi.waitFor(() =>
      expect(settleLiveAdmissionWorkItem).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'admission-1',
          workerInstanceId: 'worker-1',
          state: 'completed',
        }),
      ),
    );
    expect(claimLiveAdmissionWorkItems).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'default' }),
    );
    expect(renewLiveAdmissionWorkItemClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'admission-1',
        workerInstanceId: 'worker-1',
      }),
    );
    loop.stop();
    await loop.done;
  });

  it('renews a claimed work item while processing is still in flight', async () => {
    const settleLiveAdmissionWorkItem = vi.fn(async () => true);
    const renewLiveAdmissionWorkItemClaim = vi.fn(async () => true);
    const replay = deferred<(typeof replayMessage)[]>();
    const deps = makeDeps(() => true);
    deps.opsRepository.getMessagesSince = vi.fn(() => replay.promise);
    const loop = startLiveAdmissionWorkLoop({
      liveAdmissions: {
        claimLiveAdmissionWorkItems: vi.fn(async () => [baseItem]),
        renewLiveAdmissionWorkItemClaim,
        deferLiveAdmissionWorkItem: vi.fn(),
        settleLiveAdmissionWorkItem,
        enqueueLiveAdmissionWorkItem: vi.fn(),
      },
      appId: 'default',
      workerInstanceId: 'worker-1',
      messageLoopDeps: deps,
      claimTtlMs: 60,
      claimRenewalIntervalMs: 5,
      intervalMs: 60_000,
      maxBatchesPerWake: 1,
      warn: vi.fn(),
    });

    await vi.waitFor(() =>
      expect(renewLiveAdmissionWorkItemClaim.mock.calls.length).toBeGreaterThan(
        1,
      ),
    );
    replay.resolve([replayMessage]);
    await vi.waitFor(() =>
      expect(settleLiveAdmissionWorkItem).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'admission-1',
          workerInstanceId: 'worker-1',
          state: 'completed',
        }),
      ),
    );

    loop.stop();
    await loop.done;
  });

  it('defers a claimed work item when the queue rejects capacity', async () => {
    const deferLiveAdmissionWorkItem = vi.fn(async () => true);
    const loop = startLiveAdmissionWorkLoop({
      liveAdmissions: {
        claimLiveAdmissionWorkItems: vi.fn(async () => [baseItem]),
        renewLiveAdmissionWorkItemClaim: vi.fn(async () => true),
        deferLiveAdmissionWorkItem,
        settleLiveAdmissionWorkItem: vi.fn(),
        enqueueLiveAdmissionWorkItem: vi.fn(),
      },
      appId: 'default',
      workerInstanceId: 'worker-1',
      messageLoopDeps: makeDeps(() => false),
      intervalMs: 60_000,
      maxBatchesPerWake: 1,
      warn: vi.fn(),
    });

    await vi.waitFor(() =>
      expect(deferLiveAdmissionWorkItem).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'admission-1',
          workerInstanceId: 'worker-1',
          reason: 'queued_capacity',
        }),
      ),
    );
    loop.stop();
    await loop.done;
  });

  it('recovers a dropped wakeup by replaying due durable work on the interval', async () => {
    const settleLiveAdmissionWorkItem = vi.fn(async () => true);
    const claimLiveAdmissionWorkItems = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([baseItem])
      .mockResolvedValue([]);
    const deps = makeDeps(() => true);
    const loop = startLiveAdmissionWorkLoop({
      liveAdmissions: {
        claimLiveAdmissionWorkItems,
        renewLiveAdmissionWorkItemClaim: vi.fn(async () => true),
        deferLiveAdmissionWorkItem: vi.fn(),
        settleLiveAdmissionWorkItem,
        enqueueLiveAdmissionWorkItem: vi.fn(),
      },
      appId: 'default',
      workerInstanceId: 'worker-1',
      messageLoopDeps: deps,
      intervalMs: 5,
      maxBatchesPerWake: 1,
      warn: vi.fn(),
    });

    await vi.waitFor(() =>
      expect(settleLiveAdmissionWorkItem).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'admission-1',
          workerInstanceId: 'worker-1',
          state: 'completed',
        }),
      ),
    );

    loop.stop();
    await loop.done;

    expect(
      claimLiveAdmissionWorkItems.mock.calls.length,
    ).toBeGreaterThanOrEqual(2);
    expect(deps.opsRepository.getNewMessages).not.toHaveBeenCalled();
  });

  it('settles poison work items as failed after the retry limit', async () => {
    const settleLiveAdmissionWorkItem = vi.fn(async () => true);
    const deferLiveAdmissionWorkItem = vi.fn(async () => true);
    const loop = startLiveAdmissionWorkLoop({
      liveAdmissions: {
        claimLiveAdmissionWorkItems: vi.fn(async () => [
          {
            ...baseItem,
            queueJid: 'other@g.us',
            failureCount: 2,
          },
        ]),
        renewLiveAdmissionWorkItemClaim: vi.fn(async () => true),
        deferLiveAdmissionWorkItem,
        settleLiveAdmissionWorkItem,
        enqueueLiveAdmissionWorkItem: vi.fn(),
      },
      appId: 'default',
      workerInstanceId: 'worker-1',
      messageLoopDeps: makeDeps(() => true),
      intervalMs: 60_000,
      maxBatchesPerWake: 1,
      maxRetryCount: 3,
      warn: vi.fn(),
    });

    await vi.waitFor(() =>
      expect(settleLiveAdmissionWorkItem).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'admission-1',
          state: 'failed',
        }),
      ),
    );
    expect(deferLiveAdmissionWorkItem).not.toHaveBeenCalled();
    loop.stop();
    await loop.done;
  });

  it('does not dead-letter from claim count alone', async () => {
    const settleLiveAdmissionWorkItem = vi.fn(async () => true);
    const deferLiveAdmissionWorkItem = vi.fn(async () => true);
    const loop = startLiveAdmissionWorkLoop({
      liveAdmissions: {
        claimLiveAdmissionWorkItems: vi.fn(async () => [
          {
            ...baseItem,
            queueJid: 'other@g.us',
            retryCount: 99,
            failureCount: 0,
          },
        ]),
        renewLiveAdmissionWorkItemClaim: vi.fn(async () => true),
        deferLiveAdmissionWorkItem,
        settleLiveAdmissionWorkItem,
        enqueueLiveAdmissionWorkItem: vi.fn(),
      },
      appId: 'default',
      workerInstanceId: 'worker-1',
      messageLoopDeps: makeDeps(() => true),
      intervalMs: 60_000,
      maxBatchesPerWake: 1,
      maxRetryCount: 3,
      warn: vi.fn(),
    });

    await vi.waitFor(() =>
      expect(deferLiveAdmissionWorkItem).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'admission-1',
          reason: 'listener_degraded',
          countFailure: true,
        }),
      ),
    );
    expect(settleLiveAdmissionWorkItem).not.toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'admission-1',
        state: 'failed',
      }),
    );
    loop.stop();
    await loop.done;
  });

  it('releases unstarted claimed work items when shutdown drain times out', async () => {
    const deferLiveAdmissionWorkItem = vi.fn(async () => true);
    const renewLiveAdmissionWorkItemClaim = vi.fn(async () => true);
    const deps = makeDeps(() => true);
    deps.opsRepository.getMessagesSince = vi.fn(
      () => new Promise(() => undefined),
    );
    const loop = startLiveAdmissionWorkLoop({
      liveAdmissions: {
        claimLiveAdmissionWorkItems: vi.fn(async () => [
          baseItem,
          { ...baseItem, id: 'admission-2' },
        ]),
        renewLiveAdmissionWorkItemClaim,
        deferLiveAdmissionWorkItem,
        settleLiveAdmissionWorkItem: vi.fn(),
        enqueueLiveAdmissionWorkItem: vi.fn(),
      },
      appId: 'default',
      workerInstanceId: 'worker-1',
      messageLoopDeps: deps,
      intervalMs: 60_000,
      maxBatchesPerWake: 1,
      warn: vi.fn(),
    });

    await vi.waitFor(() =>
      expect(renewLiveAdmissionWorkItemClaim).toHaveBeenCalled(),
    );
    await loop.stop({ drainDeadlineMs: 0 });

    expect(deferLiveAdmissionWorkItem).not.toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'admission-1',
      }),
    );
    expect(deferLiveAdmissionWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'admission-2',
        reason: 'retry',
      }),
    );
  });
});
