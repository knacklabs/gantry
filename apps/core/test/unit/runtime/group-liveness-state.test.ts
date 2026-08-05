import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GroupLivenessController,
  STALL_HEARTBEAT_THRESHOLD_MS,
} from '@core/runtime/group-liveness-state.js';
import type { ProgressChannelSender } from '@core/runtime/group-progress-channel-sender.js';

function deferred<T = void>(): {
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

function setupController(
  overrides: Partial<
    ConstructorParameters<typeof GroupLivenessController>[0]
  > = {},
) {
  const setTyping = vi.fn().mockResolvedValue(undefined);
  const sendProgressToChannel = Object.assign(
    vi.fn(async () => true),
    {
      beforeVisibleDelivery: vi.fn(async () => undefined),
      recordVisibleDelivery: vi.fn(),
      cancelPendingStallNotices: vi.fn(),
      retire: vi.fn(),
    },
  ) as ProgressChannelSender;
  const debug = vi.fn();
  const controller = new GroupLivenessController({
    supportsProgress: true,
    chatJid: 'discord:parent',
    activeThreadId: 'thread',
    groupName: 'group',
    channelRuntime: { setTyping } as never,
    buildProgressOptions: (options) => ({
      ...options,
      threadId: 'thread',
      generation: 7,
    }),
    sendProgressToChannel,
    log: { debug },
    ...overrides,
  });
  return { controller, debug, sendProgressToChannel, setTyping };
}

describe('GroupLivenessController', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('bounds and detaches a first reaction that never settles', async () => {
    const neverSettles = new Promise<void>(() => undefined);
    const onFirstProgress = vi.fn(() => neverSettles);
    const { controller, debug } = setupController({ onFirstProgress });

    controller.start({ jid: 'discord:parent', messageRef: 'message-1' });
    await vi.advanceTimersByTimeAsync(0);

    expect(controller.currentPhase()).toBe('active');
    expect(onFirstProgress).toHaveBeenCalledWith({
      jid: 'discord:parent',
      messageRef: 'message-1',
    });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(debug).toHaveBeenCalledWith(
      { group: 'group' },
      'First reaction admission timed out',
    );
    await controller.terminal();
  });

  it('keeps typing suppressed for stalled in-flight and failed delivery, then refreshes immediately after success', async () => {
    const visibleOrdering = deferred<void>();
    const { controller, sendProgressToChannel, setTyping } = setupController();
    sendProgressToChannel.beforeVisibleDelivery = vi
      .fn()
      .mockReturnValueOnce(visibleOrdering.promise)
      .mockResolvedValue(undefined);
    controller.start(null);
    setTyping.mockClear();

    await vi.advanceTimersByTimeAsync(STALL_HEARTBEAT_THRESHOLD_MS);
    expect(controller.currentPhase()).toBe('stalled');
    expect(sendProgressToChannel).toHaveBeenCalledWith(
      'Still working',
      expect.objectContaining({ replaceOnly: true }),
    );
    setTyping.mockClear();

    const inFlight = controller.beginVisibleDelivery();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(controller.currentPhase()).toBe('delivering');
    expect(setTyping).not.toHaveBeenCalled();
    visibleOrdering.resolve(undefined);
    await inFlight;

    await controller.finishVisibleDelivery(false);
    expect(controller.currentPhase()).toBe('stalled');
    expect(setTyping).not.toHaveBeenCalled();

    await controller.beginVisibleDelivery();
    await controller.finishVisibleDelivery(true);
    expect(controller.currentPhase()).toBe('active');
    expect(setTyping).toHaveBeenCalledTimes(1);
    expect(setTyping).toHaveBeenLastCalledWith('discord:parent', true, {
      threadId: 'thread',
    });
    await controller.terminal();
  });

  it('keeps a rejected stall claim sticky until a successful visible delivery', async () => {
    const sendStall = deferred<boolean>();
    const { controller, sendProgressToChannel, setTyping } = setupController();
    sendProgressToChannel.mockImplementation(() => sendStall.promise);
    controller.start(null);
    setTyping.mockClear();

    await vi.advanceTimersByTimeAsync(STALL_HEARTBEAT_THRESHOLD_MS);
    sendStall.reject(new Error('provider rejected stall edit'));
    setTyping.mockClear();
    await vi.advanceTimersByTimeAsync(STALL_HEARTBEAT_THRESHOLD_MS);

    expect(sendProgressToChannel).toHaveBeenCalledTimes(1);
    expect(setTyping).not.toHaveBeenCalled();

    await controller.beginVisibleDelivery();
    await controller.finishVisibleDelivery(true);
    expect(setTyping).toHaveBeenCalledTimes(1);
    await controller.terminal();
  });

  it('retries a definitive missing stall notice only after the retry delay', async () => {
    const { controller, sendProgressToChannel, setTyping } = setupController();
    sendProgressToChannel
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    controller.start(null);

    await vi.advanceTimersByTimeAsync(STALL_HEARTBEAT_THRESHOLD_MS);
    expect(sendProgressToChannel).toHaveBeenCalledTimes(1);
    setTyping.mockClear();

    await vi.advanceTimersByTimeAsync(STALL_HEARTBEAT_THRESHOLD_MS - 4_000);
    expect(sendProgressToChannel).toHaveBeenCalledTimes(1);
    expect(setTyping).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(4_000);
    expect(sendProgressToChannel).toHaveBeenCalledTimes(2);
    expect(setTyping).not.toHaveBeenCalled();
    await controller.terminal();
  });

  it('refreshes typing during an active delivery lease until the lease expires', async () => {
    const neverSettles = new Promise<void>(() => undefined);
    const { controller, sendProgressToChannel, setTyping } = setupController();
    sendProgressToChannel.beforeVisibleDelivery = vi.fn(() => neverSettles);
    controller.start(null);
    setTyping.mockClear();

    void controller.beginVisibleDelivery();
    await vi.advanceTimersByTimeAsync(4_000);

    expect(controller.currentPhase()).toBe('delivering');
    expect(setTyping).toHaveBeenCalledWith('discord:parent', true, {
      threadId: 'thread',
    });

    await vi.advanceTimersByTimeAsync(STALL_HEARTBEAT_THRESHOLD_MS - 8_000);
    expect(setTyping).toHaveBeenCalled();

    setTyping.mockClear();
    await vi.advanceTimersByTimeAsync(4_000);

    expect(controller.currentPhase()).toBe('stalled');
    expect(sendProgressToChannel).toHaveBeenCalledWith(
      'Still working',
      expect.objectContaining({ replaceOnly: true }),
    );
    expect(setTyping).not.toHaveBeenCalled();
    await controller.terminal();
  });

  it('detaches a hung first-visible cleanup after the bound and keeps terminal progress fenced', async () => {
    const cleanup = deferred<void>();
    const onFirstVisibleOutput = vi.fn(() => cleanup.promise);
    const { controller, debug, sendProgressToChannel } = setupController({
      onFirstVisibleOutput,
    });
    controller.start(null);
    await controller.beginVisibleDelivery();

    const finished = controller.finishVisibleDelivery(true);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(sendProgressToChannel.recordVisibleDelivery).toHaveBeenCalledWith(
      'Done.',
      { done: true, threadId: 'thread', generation: 7 },
    );

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
    await controller.terminal();
  });

  it('orders a slow typing start before terminal off and ends typing off', async () => {
    const slowStart = deferred<void>();
    let providerTyping = false;
    const applied: boolean[] = [];
    const setTyping = vi.fn(async (_jid: string, isTyping: boolean) => {
      if (isTyping) await slowStart.promise;
      providerTyping = isTyping;
      applied.push(isTyping);
    });
    const { controller } = setupController({
      channelRuntime: { setTyping } as never,
    });
    controller.start(null);

    let terminalSettled = false;
    const terminal = controller.terminal().then(() => {
      terminalSettled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(terminalSettled).toBe(false);
    expect(applied).toEqual([]);
    expect(setTyping).toHaveBeenCalledTimes(1);

    slowStart.resolve(undefined);
    await terminal;
    expect(applied).toEqual([true, false]);
    expect(providerTyping).toBe(false);
  });

  it('resumes typing after an interaction wait', async () => {
    const { controller, setTyping } = setupController();
    controller.start(null);
    await vi.advanceTimersByTimeAsync(0);

    controller.pause();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.currentPhase()).toBe('waiting');
    expect(setTyping).toHaveBeenLastCalledWith('discord:parent', false, {
      threadId: 'thread',
    });

    controller.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.currentPhase()).toBe('active');
    expect(setTyping).toHaveBeenLastCalledWith('discord:parent', true, {
      threadId: 'thread',
    });
    await controller.terminal();
  });

  it('keeps a turn-complete pause resumable without treating it as an interaction finalizer', async () => {
    const { controller, setTyping } = setupController();
    controller.start(null);
    await vi.advanceTimersByTimeAsync(0);

    controller.pauseForTurnComplete();
    await vi.advanceTimersByTimeAsync(0);
    setTyping.mockClear();

    controller.resumeWaitingForUser();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.currentPhase()).toBe('waiting');
    expect(setTyping).not.toHaveBeenCalled();

    controller.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.currentPhase()).toBe('active');
    expect(setTyping).toHaveBeenLastCalledWith('discord:parent', true, {
      threadId: 'thread',
    });
    await controller.terminal();
  });

  it('upgrades a turn-complete pause to a waiting-for-user pause', async () => {
    const { controller, setTyping } = setupController();
    controller.start(null);
    await vi.advanceTimersByTimeAsync(0);

    controller.pauseForTurnComplete();
    await vi.advanceTimersByTimeAsync(0);
    setTyping.mockClear();

    expect(controller.pause()).toBe(true);
    expect(controller.pause()).toBe(false);
    controller.resumeWaitingForUser();
    await vi.advanceTimersByTimeAsync(0);

    expect(controller.currentPhase()).toBe('active');
    expect(setTyping).toHaveBeenLastCalledWith('discord:parent', true, {
      threadId: 'thread',
    });
    await controller.terminal();
  });

  it('restores a turn-complete pause after visible delivery without restarting liveness', async () => {
    const { controller, sendProgressToChannel, setTyping } = setupController();
    controller.start(null);
    await vi.advanceTimersByTimeAsync(0);
    controller.pauseForTurnComplete();
    await vi.advanceTimersByTimeAsync(0);
    setTyping.mockClear();

    await controller.beginVisibleDelivery();
    await controller.finishVisibleDelivery(true);

    expect(controller.currentPhase()).toBe('waiting');
    await vi.advanceTimersByTimeAsync(STALL_HEARTBEAT_THRESHOLD_MS);
    expect(setTyping).not.toHaveBeenCalledWith(
      'discord:parent',
      true,
      expect.anything(),
    );
    expect(sendProgressToChannel).not.toHaveBeenCalledWith(
      'Still working',
      expect.anything(),
    );

    controller.resumeWaitingForUser();
    expect(controller.currentPhase()).toBe('waiting');
    controller.resume();
    expect(controller.currentPhase()).toBe('active');
    await controller.terminal();
  });

  it('coalesces rapid typing changes to one in-flight and the newest queued value', async () => {
    const slowStart = deferred<void>();
    const applied: boolean[] = [];
    const setTyping = vi.fn(async (_jid: string, isTyping: boolean) => {
      if (applied.length === 0) await slowStart.promise;
      applied.push(isTyping);
    });
    const { controller } = setupController({
      channelRuntime: { setTyping } as never,
    });
    controller.start(null);

    for (let index = 0; index < 50; index += 1) {
      controller.pause();
      controller.resume();
    }
    expect(setTyping).toHaveBeenCalledTimes(1);

    const terminal = controller.terminal();
    expect(setTyping).toHaveBeenCalledTimes(1);
    slowStart.resolve();
    await terminal;

    expect(setTyping.mock.calls.map((call) => call[1])).toEqual([true, false]);
    expect(applied).toEqual([true, false]);
  });

  it('enters terminal once and awaits the ordered typing off', async () => {
    const onTerminal = vi.fn();
    const { controller, setTyping } = setupController({ onTerminal });
    controller.start(null);
    await vi.advanceTimersByTimeAsync(0);
    setTyping.mockClear();

    const firstTerminal = controller.terminal();
    const secondTerminal = controller.terminal();
    await Promise.all([firstTerminal, secondTerminal]);

    expect(controller.currentPhase()).toBe('terminal');
    expect(onTerminal).toHaveBeenCalledOnce();
    expect(setTyping).toHaveBeenCalledOnce();
    expect(setTyping).toHaveBeenCalledWith('discord:parent', false, {
      threadId: 'thread',
    });
  });
});
