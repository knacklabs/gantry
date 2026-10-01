import { describe, expect, it, vi } from 'vitest';

import {
  processLiveAdmissionWorkItem,
  recoverPendingMessages,
  type MessageLoopDeps,
} from '@core/runtime/message-loop.js';
import type { LiveAdmissionWorkItem } from '@core/domain/ports/live-turns.js';
import { GroupQueue } from '@core/runtime/group-queue.js';

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

  it('interrupts an active turn when its own authorized stop message arrives', async () => {
    const queue = new GroupQueue();
    let finishRun: () => void = () => undefined;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const running = new Promise<void>((resolve) => {
      finishRun = resolve;
    });
    queue.setProcessMessagesFn(async () => {
      markStarted();
      await running;
      return true;
    });
    const queueJid = 'tg:team::agent:team';
    queue.enqueueMessageCheck(queueJid);
    await started;
    queue.registerProcess(
      queueJid,
      { pid: 9_999_991, killed: false, kill: vi.fn() } as never,
      'run',
      'team',
    );
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true as never);
    const { input } = deps();
    const consumeInputItem = vi.fn(async () => true);
    input.queue = queue;
    input.inputRepository = {
      consumeInputItem,
      consumeAll: vi.fn(async () => 0),
    } as never;
    input.opsRepository = {
      getMessagesByIds: vi.fn(async () => [
        {
          id: 'message-1',
          chat_jid: 'tg:team',
          sender: 'user',
          content: '/stop',
          timestamp: '2026-09-29T00:00:00Z',
          is_from_me: true,
          is_bot_message: false,
        },
      ]),
    } as never;
    input.handleActiveControlCommand = async ({ command }) =>
      command.kind === 'stop' && queue.stopGroup(queueJid);
    try {
      await processLiveAdmissionWorkItem(input, workItem());
      expect(kill).toHaveBeenCalledWith(-9_999_991, 'SIGTERM');
      expect(consumeInputItem).toHaveBeenCalledWith({
        id: 'work-1',
        consumedBy: 'control:work-1',
      });
    } finally {
      kill.mockRestore();
      finishRun();
      await queue.shutdown();
    }
  });

  it.each([
    { claimed: false, handled: true, runs: false, released: false },
    { claimed: true, handled: false, runs: true, released: true },
    { claimed: true, handled: 'throws', runs: true, released: false },
  ])(
    'claims an active stop before running it: %j',
    async ({ claimed, handled, runs, released }) => {
      const { input, enqueueMessageCheck } = deps();
      const releaseInput = vi.fn(async () => 1);
      input.inputRepository = {
        consumeInputItem: vi.fn(async () => claimed),
        consumeAll: vi.fn(async () => 0),
        releaseInput,
      } as never;
      input.opsRepository = {
        getMessagesByIds: vi.fn(async () => [
          {
            id: 'message-1',
            chat_jid: 'tg:team',
            sender: 'user',
            content: '/stop',
            timestamp: '2026-09-29T00:00:00Z',
            is_from_me: true,
            is_bot_message: false,
          },
        ]),
      } as never;
      const handleActiveControlCommand = vi.fn(async () => {
        if (handled === 'throws') throw new Error('stop failed midway');
        return handled;
      });
      input.handleActiveControlCommand = handleActiveControlCommand;

      const processed = processLiveAdmissionWorkItem(input, workItem());
      if (handled === 'throws') await expect(processed).rejects.toThrow();
      else await processed;

      expect(handleActiveControlCommand).toHaveBeenCalledTimes(runs ? 1 : 0);
      expect(releaseInput).toHaveBeenCalledTimes(released ? 1 : 0);
      expect(enqueueMessageCheck).toHaveBeenCalledTimes(
        claimed && handled === false ? 1 : 0,
      );
    },
  );

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
