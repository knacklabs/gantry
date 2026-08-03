import { describe, expect, it, vi } from 'vitest';

import { startGroupLivenessHeartbeat } from '@core/runtime/group-liveness-state.js';
import type { ProgressChannelSender } from '@core/runtime/group-progress-channel-sender.js';

function deferredRejection(): {
  promise: Promise<void>;
  reject: (error: Error) => void;
} {
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((_resolve, rejectPromise) => {
    reject = rejectPromise;
  });
  return { promise, reject };
}

describe('startGroupLivenessHeartbeat', () => {
  it('detaches a hung first-visible cleanup after the bound and keeps terminal progress fenced', async () => {
    vi.useFakeTimers();
    const cleanup = deferredRejection();
    const recordVisibleDelivery = vi.fn();
    const debug = vi.fn();
    const sendProgressToChannel = Object.assign(
      vi.fn(async () => true),
      {
        beforeVisibleDelivery: vi.fn(async () => {}),
        recordVisibleDelivery,
        cancelPendingStallNotices: vi.fn(),
        retire: vi.fn(),
      },
    ) as ProgressChannelSender;
    const heartbeat = startGroupLivenessHeartbeat({
      supportsProgress: true,
      isTypingActive: () => false,
      chatJid: 'discord:parent',
      activeThreadId: 'thread',
      groupName: 'group',
      channelRuntime: { setTyping: vi.fn(async () => {}) } as never,
      buildProgressOptions: (options) => ({
        ...options,
        threadId: 'thread',
        generation: 7,
      }),
      sendProgressToChannel,
      onFirstVisibleOutput: () => cleanup.promise,
      log: { debug },
    });

    const finished = heartbeat.finishVisibleOutputDelivery(true);
    let settled = false;
    void finished.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1_999);

    expect(settled).toBe(false);
    expect(recordVisibleDelivery).toHaveBeenCalledWith('Done.', {
      done: true,
      threadId: 'thread',
      generation: 7,
    });

    await vi.advanceTimersByTimeAsync(1);
    await expect(finished).resolves.toBeUndefined();
    expect(debug).toHaveBeenCalledWith(
      { group: 'group' },
      'First visible output hook timed out',
    );

    const error = new Error('late reaction failure');
    cleanup.reject(error);
    await vi.advanceTimersByTimeAsync(0);
    expect(debug).toHaveBeenCalledWith(
      { err: error, group: 'group' },
      'First visible output hook failed',
    );
    vi.useRealTimers();
  });
});
