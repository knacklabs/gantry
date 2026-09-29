import { describe, expect, it, vi } from 'vitest';

import {
  processLiveAdmissionWorkItem,
  recoverPendingMessages,
  type MessageLoopDeps,
} from '@core/runtime/message-loop.js';
import type { LiveAdmissionWorkItem } from '@core/domain/ports/live-turns.js';

function workItem(
  overrides: Partial<LiveAdmissionWorkItem> = {},
): LiveAdmissionWorkItem {
  return {
    id: 'work-1',
    appId: 'app',
    agentId: 'team',
    agentSessionId: null,
    conversationId: 'tg:team',
    threadId: null,
    providerAccountId: null,
    queueJid: 'tg:team::agent:team',
    messageId: 'message-1',
    messageCursor: '{"timestamp":"2026-09-29T00:00:00Z","id":"message-1"}',
    receiveOrder: 1,
    consumedAt: null,
    consumedBy: null,
    senderUserId: 'user',
    senderDisplayName: 'User',
    idempotencyKey: 'delivery-1',
    state: 'claimed',
    sourceKind: 'message',
    triggerDecision: {},
    claimWorkerInstanceId: 'worker',
    claimToken: 'claim',
    claimExpiresAt: null,
    fencingVersion: 1,
    retryCount: 0,
    failureCount: 0,
    deferUntil: null,
    deferredReason: null,
    createdAt: '2026-09-29T00:00:00Z',
    updatedAt: '2026-09-29T00:00:00Z',
    claimedAt: null,
    endedAt: null,
    ...overrides,
  };
}

function deps() {
  const enqueueMessageCheck = vi.fn().mockReturnValue(true);
  const input = {
    getConversationRoutes: () => ({
      'tg:team::agent:team': {
        name: 'Team',
        folder: 'team',
        requiresTrigger: false,
      },
    }),
    hasChannel: () => true,
    queue: { enqueueMessageCheck },
  } as unknown as MessageLoopDeps;
  return { input, enqueueMessageCheck };
}

describe('durable admission wakeup', () => {
  it('wakes an unconsumed completed item after restart without taking it', async () => {
    const { input, enqueueMessageCheck } = deps();
    const listUnconsumedLiveAdmissionQueueJids = vi.fn(async () => [
      'tg:team::agent:team',
    ]);
    const takeInput = vi.fn();
    Object.assign(input, {
      appId: 'app',
      inputRepository: { listUnconsumedLiveAdmissionQueueJids, takeInput },
    });

    await recoverPendingMessages(input);

    expect(listUnconsumedLiveAdmissionQueueJids).toHaveBeenCalledWith({
      appId: 'app',
    });
    expect(enqueueMessageCheck).toHaveBeenCalledExactlyOnceWith(
      'tg:team::agent:team',
    );
    expect(takeInput).not.toHaveBeenCalled();
  });

  it('wakes a turn without taking or reading its message', async () => {
    const { input, enqueueMessageCheck } = deps();
    const read = vi.fn();
    input.opsRepository = {
      getMessagesByIds: read,
    } as unknown as MessageLoopDeps['opsRepository'];

    await expect(processLiveAdmissionWorkItem(input, workItem())).resolves.toBe(
      'completed',
    );

    expect(enqueueMessageCheck).toHaveBeenCalledExactlyOnceWith(
      'tg:team::agent:team',
    );
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects a work item whose queue identity does not match its scope', async () => {
    const { input, enqueueMessageCheck } = deps();

    await expect(
      processLiveAdmissionWorkItem(
        input,
        workItem({ conversationId: 'tg:other' }),
      ),
    ).resolves.toBe('listener_degraded');

    expect(enqueueMessageCheck).not.toHaveBeenCalled();
  });

  it('returns capacity pressure so durable admission retries the wakeup', async () => {
    const { input } = deps();
    input.queue.enqueueMessageCheck = vi.fn().mockReturnValue(false);

    await expect(processLiveAdmissionWorkItem(input, workItem())).resolves.toBe(
      'queued_capacity',
    );
  });
});
