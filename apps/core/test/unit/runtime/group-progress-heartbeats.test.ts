import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  STALL_HEARTBEAT_THRESHOLD_MS,
  startGroupProgressHeartbeats,
} from '@core/runtime/group-progress-heartbeats.js';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('startGroupProgressHeartbeats', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the stall claim held and typing suppressed when the notice rejects', async () => {
    let claimed = false;
    const releaseStallNotice = vi.fn(() => {
      claimed = false;
    });
    const sendStallProgress = vi.fn(() =>
      Promise.reject(new Error('provider rejected stall edit')),
    );
    const setTyping = vi.fn().mockResolvedValue(undefined);
    const debug = vi.fn();
    const heartbeat = startGroupProgressHeartbeats({
      supportsProgress: true,
      isTypingActive: () => true,
      chatJid: 'discord:parent',
      groupName: 'thread',
      isStalled: () => true,
      claimStallNotice: () => {
        if (claimed) return false;
        claimed = true;
        return true;
      },
      releaseStallNotice,
      sendStallProgress,
      beforeVisibleDelivery: vi.fn(async () => undefined),
      cancelPendingStallNotices: vi.fn(),
      channelRuntime: { setTyping },
      log: { debug },
    });

    await vi.advanceTimersByTimeAsync(4_000);
    await vi.advanceTimersByTimeAsync(STALL_HEARTBEAT_THRESHOLD_MS);

    expect(sendStallProgress).toHaveBeenCalledTimes(1);
    expect(releaseStallNotice).not.toHaveBeenCalled();
    expect(setTyping).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(
      expect.objectContaining({ group: 'thread' }),
      'Failed to send stalled progress heartbeat',
    );

    heartbeat.finishVisibleDelivery(true);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(sendStallProgress).toHaveBeenCalledTimes(2);
    clearInterval(heartbeat.typingHeartbeatTimer);
  });

  it('releases a definitive false without typing and retries after one stall interval', async () => {
    let claimed = false;
    const releaseStallNotice = vi.fn(() => {
      claimed = false;
    });
    const sendStallProgress = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const setTyping = vi.fn().mockResolvedValue(undefined);
    const heartbeat = startGroupProgressHeartbeats({
      supportsProgress: true,
      isTypingActive: () => true,
      chatJid: 'discord:parent',
      groupName: 'thread',
      isStalled: () => true,
      claimStallNotice: () => {
        if (claimed) return false;
        claimed = true;
        return true;
      },
      releaseStallNotice,
      sendStallProgress,
      beforeVisibleDelivery: vi.fn(async () => undefined),
      cancelPendingStallNotices: vi.fn(),
      channelRuntime: { setTyping },
      log: { debug: vi.fn() },
    });

    await vi.advanceTimersByTimeAsync(4_000);
    expect(sendStallProgress).toHaveBeenCalledTimes(1);
    expect(releaseStallNotice).toHaveBeenCalledTimes(1);
    expect(setTyping).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(STALL_HEARTBEAT_THRESHOLD_MS - 4_000);
    expect(sendStallProgress).toHaveBeenCalledTimes(1);
    expect(setTyping).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(4_000);
    expect(sendStallProgress).toHaveBeenCalledTimes(2);
    expect(setTyping).not.toHaveBeenCalled();
    clearInterval(heartbeat.typingHeartbeatTimer);
  });

  it('releases an obsolete stall claim after pause so a resumed heartbeat can retry', async () => {
    const firstAttempt = deferred<boolean>();
    let claimed = false;
    const sendStallProgress = vi
      .fn()
      .mockImplementationOnce(() => firstAttempt.promise)
      .mockResolvedValue(true);
    const heartbeat = startGroupProgressHeartbeats({
      supportsProgress: true,
      isTypingActive: () => true,
      chatJid: 'discord:parent',
      groupName: 'thread',
      isStalled: () => true,
      claimStallNotice: () => {
        if (claimed) return false;
        claimed = true;
        return true;
      },
      releaseStallNotice: () => {
        claimed = false;
      },
      sendStallProgress,
      beforeVisibleDelivery: vi.fn(async () => undefined),
      cancelPendingStallNotices: vi.fn(),
      channelRuntime: { setTyping: vi.fn().mockResolvedValue(undefined) },
      log: { debug: vi.fn() },
    });

    await vi.advanceTimersByTimeAsync(4_000);
    expect(sendStallProgress).toHaveBeenCalledTimes(1);

    heartbeat.pause();
    firstAttempt.reject(new Error('provider rejected obsolete edit'));
    await Promise.resolve();
    heartbeat.resume();
    await vi.advanceTimersByTimeAsync(4_000);

    expect(sendStallProgress).toHaveBeenCalledTimes(2);
    clearInterval(heartbeat.typingHeartbeatTimer);
  });

  it('resumes stall evaluation when a visible delivery exceeds its lease', async () => {
    const neverSettles = new Promise<void>(() => undefined);
    let claimed = false;
    const sendStallProgress = vi.fn().mockResolvedValue(true);
    const setTyping = vi.fn().mockResolvedValue(undefined);
    const heartbeat = startGroupProgressHeartbeats({
      supportsProgress: true,
      isTypingActive: () => true,
      chatJid: 'discord:parent',
      groupName: 'thread',
      isStalled: () => true,
      claimStallNotice: () => {
        if (claimed) return false;
        claimed = true;
        return true;
      },
      releaseStallNotice: () => {
        claimed = false;
      },
      sendStallProgress,
      beforeVisibleDelivery: () => neverSettles,
      cancelPendingStallNotices: vi.fn(),
      channelRuntime: { setTyping },
      log: { debug: vi.fn() },
    });

    void heartbeat.beginVisibleDelivery();
    await vi.advanceTimersByTimeAsync(179_999);
    expect(sendStallProgress).not.toHaveBeenCalled();
    const typingBeforeLeaseExpiry = setTyping.mock.calls.length;

    await vi.advanceTimersByTimeAsync(4_001);

    expect(sendStallProgress).toHaveBeenCalledTimes(1);
    expect(setTyping.mock.calls).toHaveLength(typingBeforeLeaseExpiry);
    clearInterval(heartbeat.typingHeartbeatTimer);
  });

  it('invalidates a lease-era stall request after visible delivery succeeds', async () => {
    const stalled = deferred<boolean>();
    let claimed = false;
    const setTyping = vi.fn().mockResolvedValue(undefined);
    const heartbeat = startGroupProgressHeartbeats({
      supportsProgress: true,
      isTypingActive: () => true,
      chatJid: 'discord:parent',
      groupName: 'thread',
      isStalled: () => true,
      claimStallNotice: () => {
        if (claimed) return false;
        claimed = true;
        return true;
      },
      releaseStallNotice: () => {
        claimed = false;
      },
      sendStallProgress: () => stalled.promise,
      beforeVisibleDelivery: vi.fn(async () => undefined),
      cancelPendingStallNotices: vi.fn(),
      channelRuntime: { setTyping },
      log: { debug: vi.fn() },
    });

    await heartbeat.beginVisibleDelivery();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(claimed).toBe(true);
    const typingAtLeaseExpiry = setTyping.mock.calls.length;

    heartbeat.finishVisibleDelivery(true);
    stalled.reject(new Error('obsolete stall edit rejected'));
    await Promise.resolve();

    expect(setTyping).toHaveBeenCalledTimes(typingAtLeaseExpiry);
    expect(claimed).toBe(false);
    clearInterval(heartbeat.typingHeartbeatTimer);
  });
});
