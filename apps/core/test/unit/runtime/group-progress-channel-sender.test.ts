import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createProgressChannelSender,
  progressOrderingRegistrySize,
} from '@core/runtime/group-progress-channel-sender.js';

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

describe('createProgressChannelSender', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a stalled edit before terminal Done for the same card', async () => {
    const stalled = deferred<boolean>();
    const calls: string[] = [];
    const sendProgressUpdate = vi.fn(async (_jid: string, text: string) => {
      calls.push(text);
      if (text === 'Still working') return stalled.promise;
      return true;
    });
    const finalizingGenerations = new Set<number>();
    const sender = createProgressChannelSender({
      channelRuntime: { sendProgressUpdate } as never,
      chatJid: 'discord:parent',
      groupName: 'thread',
      finalizingGenerations,
      log: { warn: vi.fn() },
    });
    const options = { threadId: 'thread', generation: 7 };

    const stall = sender('Still working', {
      ...options,
      replaceOnly: true,
    });
    finalizingGenerations.add(7);
    const done = sender('Done.', { ...options, done: true });

    expect(calls).toEqual(['Still working']);
    stalled.resolve(true);
    await expect(stall).resolves.toBe(true);
    await expect(done).resolves.toBe(true);
    expect(calls).toEqual(['Still working', 'Done.']);
  });

  it('drops an obsolete pre-dispatch stall link and advances terminal Done after the bound', async () => {
    const neverSettles = new Promise<boolean>(() => undefined);
    const calls: string[] = [];
    const sendProgressUpdate = vi.fn(async (_jid: string, text: string) => {
      calls.push(text);
      return text === 'Working' ? neverSettles : true;
    });
    const finalizingGenerations = new Set<number>();
    const sender = createProgressChannelSender({
      channelRuntime: { sendProgressUpdate } as never,
      chatJid: 'discord:parent',
      groupName: 'thread',
      finalizingGenerations,
      log: { warn: vi.fn() },
    });
    const options = { threadId: 'thread', generation: 11 };

    void sender('Working', options);
    const stall = sender('Still working', {
      ...options,
      replaceOnly: true,
    });
    finalizingGenerations.add(11);
    const done = sender('Done.', { ...options, done: true });

    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls).toEqual(['Working']);
    await vi.advanceTimersByTimeAsync(1);

    await expect(stall).resolves.toBe(false);
    await expect(done).resolves.toBe(true);
    expect(calls).toEqual(['Working', 'Done.']);
  });

  it('drops a pre-dispatch stall link before visible delivery', async () => {
    const neverSettles = new Promise<boolean>(() => undefined);
    const calls: string[] = [];
    const sender = createProgressChannelSender({
      channelRuntime: {
        sendProgressUpdate: vi.fn(async (_jid: string, text: string) => {
          calls.push(text);
          return text === 'Working' ? neverSettles : true;
        }),
      } as never,
      chatJid: 'discord:parent',
      groupName: 'thread',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });
    const options = { threadId: 'thread', generation: 13 };

    void sender('Working', options);
    const stall = sender('Still working', {
      ...options,
      replaceOnly: true,
    });
    const deliveryReady = sender.beforeVisibleDelivery(options);

    await vi.advanceTimersByTimeAsync(2_000);

    await expect(stall).resolves.toBe(false);
    await expect(deliveryReady).resolves.toBeUndefined();
    expect(calls).toEqual(['Working']);
  });

  it.each([
    [true, ['Still working', 'Done.', 'Done.']],
    [false, ['Still working', 'Done.']],
  ] as const)(
    'reconciles terminal state after an abandoned stalled edit settles late with %s',
    async (stallLanded, expectedCalls) => {
      const stalled = deferred<boolean>();
      const calls: string[] = [];
      const sender = createProgressChannelSender({
        channelRuntime: {
          sendProgressUpdate: vi.fn(async (_jid: string, text: string) => {
            calls.push(text);
            if (text === 'Still working') return stalled.promise;
            return true;
          }),
        } as never,
        chatJid: 'discord:parent',
        groupName: 'thread',
        finalizingGenerations: new Set<number>(),
        log: { warn: vi.fn() },
      });
      const options = { threadId: 'thread', generation: 17 };

      const stall = sender('Still working', {
        ...options,
        replaceOnly: true,
      });
      const done = sender('Done.', { ...options, done: true });

      await vi.advanceTimersByTimeAsync(2_000);
      await expect(done).resolves.toBe(true);
      expect(calls).toEqual(['Still working', 'Done.']);

      await vi.advanceTimersByTimeAsync(3_000);
      stalled.resolve(stallLanded);
      await expect(stall).resolves.toBe(stallLanded);
      await flushMicrotasks();

      expect(calls).toEqual(expectedCalls);
    },
  );

  it('reconciles again when an abandoned repair lands after a newer original', async () => {
    const stalled = deferred<boolean>();
    const repair = deferred<boolean>();
    const calls: string[] = [];
    const sender = createProgressChannelSender({
      channelRuntime: {
        sendProgressUpdate: vi.fn(async (_jid: string, text: string) => {
          calls.push(text);
          if (calls.length === 1) return stalled.promise;
          if (calls.length === 3) return repair.promise;
          return true;
        }),
      } as never,
      chatJid: 'discord:parent',
      groupName: 'thread',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });
    const options = { threadId: 'thread', generation: 19 };

    const stall = sender('Still working', {
      ...options,
      replaceOnly: true,
    });
    const done = sender('Done.', { ...options, done: true });
    await vi.advanceTimersByTimeAsync(2_000);
    await done;

    stalled.resolve(true);
    await stall;
    await flushMicrotasks();
    expect(calls).toEqual(['Still working', 'Done.', 'Done.']);

    const newest = sender('Final state.', { ...options, done: true });
    await vi.advanceTimersByTimeAsync(2_000);
    await newest;
    repair.resolve(true);
    await flushMicrotasks();

    expect(calls).toEqual([
      'Still working',
      'Done.',
      'Done.',
      'Final state.',
      'Final state.',
    ]);
  });

  it('restores a failed terminal desired payload after an older stall lands late', async () => {
    const stalled = deferred<boolean>();
    const calls: string[] = [];
    const sender = createProgressChannelSender({
      channelRuntime: {
        sendProgressUpdate: vi.fn(async (_jid: string, text: string) => {
          calls.push(text);
          if (text === 'Still working') return stalled.promise;
          if (
            text === 'Done.' &&
            calls.filter((call) => call === text).length < 3
          ) {
            return false;
          }
          return true;
        }),
      } as never,
      chatJid: 'discord:parent',
      groupName: 'thread',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });
    const options = { threadId: 'thread', generation: 21 };

    const stale = sender('Still working', {
      ...options,
      replaceOnly: true,
    });
    const done = sender('Done.', { ...options, done: true });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(done).resolves.toBe(false);
    await flushMicrotasks();
    expect(calls).toEqual(['Still working', 'Done.', 'Done.']);

    stalled.resolve(true);
    await stale;
    await flushMicrotasks();

    expect(calls).toEqual(['Still working', 'Done.', 'Done.', 'Done.']);
  });

  it('coalesces many late settlements behind one pending repair', async () => {
    const firstStall = deferred<boolean>();
    const secondStall = deferred<boolean>();
    const repair = deferred<boolean>();
    const calls: string[] = [];
    const sender = createProgressChannelSender({
      channelRuntime: {
        sendProgressUpdate: vi.fn(async (_jid: string, text: string) => {
          calls.push(text);
          if (text === 'Old state one.') return firstStall.promise;
          if (text === 'Old state two.') return secondStall.promise;
          if (calls.filter((call) => call === 'Done.').length === 2) {
            return repair.promise;
          }
          return true;
        }),
      } as never,
      chatJid: 'discord:parent',
      groupName: 'thread',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });
    const options = { threadId: 'thread', generation: 22 };

    const first = sender('Old state one.', options);
    const second = sender('Old state two.', options);
    const done = sender('Done.', { ...options, done: true });

    await vi.advanceTimersByTimeAsync(4_000);
    await done;
    firstStall.resolve(true);
    await first;
    await flushMicrotasks();
    expect(calls).toEqual([
      'Old state one.',
      'Old state two.',
      'Done.',
      'Done.',
    ]);

    secondStall.resolve(true);
    await second;
    await flushMicrotasks();
    expect(calls).toEqual([
      'Old state one.',
      'Old state two.',
      'Done.',
      'Done.',
    ]);

    repair.resolve(true);
    await flushMicrotasks();
    expect(calls).toEqual([
      'Old state one.',
      'Old state two.',
      'Done.',
      'Done.',
    ]);
  });

  it('runs one dirty reconcile after a hung repair settles', async () => {
    const firstOld = deferred<boolean>();
    const secondOld = deferred<boolean>();
    const firstRepair = deferred<boolean>();
    const calls: string[] = [];
    const sender = createProgressChannelSender({
      channelRuntime: {
        sendProgressUpdate: vi.fn(async (_jid: string, text: string) => {
          calls.push(text);
          if (calls.length === 1) return firstOld.promise;
          if (calls.length === 2) return secondOld.promise;
          if (calls.length === 4) return firstRepair.promise;
          return true;
        }),
      } as never,
      chatJid: 'discord:dirty-repair',
      groupName: 'thread',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });
    const options = { threadId: 'thread', generation: 24 };

    const first = sender('Old state one.', options);
    const second = sender('Old state two.', options);
    const done = sender('Done.', { ...options, done: true });
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(done).resolves.toBe(true);

    firstOld.resolve(true);
    await expect(first).resolves.toBe(true);
    await flushMicrotasks();
    expect(calls).toEqual([
      'Old state one.',
      'Old state two.',
      'Done.',
      'Done.',
    ]);

    secondOld.resolve(true);
    await expect(second).resolves.toBe(true);
    await flushMicrotasks();
    expect(calls).toHaveLength(4);

    await vi.advanceTimersByTimeAsync(2_000);
    firstRepair.resolve(false);
    await flushMicrotasks();

    expect(calls).toEqual([
      'Old state one.',
      'Old state two.',
      'Done.',
      'Done.',
      'Done.',
    ]);
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();
    expect(calls).toHaveLength(5);
  });

  it('resolves repair payload at dispatch and never replays an older completed update', async () => {
    const stalled = deferred<boolean>();
    const newest = deferred<boolean>();
    const calls: string[] = [];
    const sender = createProgressChannelSender({
      channelRuntime: {
        sendProgressUpdate: vi.fn(async (_jid: string, text: string) => {
          calls.push(text);
          if (text === 'Still working') return stalled.promise;
          if (text === 'Newest state.') return newest.promise;
          return true;
        }),
      } as never,
      chatJid: 'discord:parent',
      groupName: 'thread',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });
    const options = { threadId: 'thread', generation: 23 };

    const stale = sender('Still working', {
      ...options,
      replaceOnly: true,
    });
    const older = sender('Older state.', { ...options, done: true });
    await vi.advanceTimersByTimeAsync(2_000);
    await older;

    const current = sender('Newest state.', { ...options, done: true });
    stalled.resolve(true);
    await stale;
    await flushMicrotasks();
    expect(calls).toEqual(['Still working', 'Older state.', 'Newest state.']);

    newest.resolve(true);
    await current;
    await flushMicrotasks();

    expect(calls).toEqual(['Still working', 'Older state.', 'Newest state.']);
    expect(calls.filter((text) => text === 'Older state.')).toHaveLength(1);
  });

  it('repairs a stale stalled edit that settles after visible delivery', async () => {
    const stalled = deferred<boolean>();
    const calls: string[] = [];
    const sender = createProgressChannelSender({
      channelRuntime: {
        sendProgressUpdate: vi.fn(async (_jid: string, text: string) => {
          calls.push(text);
          if (text === 'Still working') return stalled.promise;
          return true;
        }),
      } as never,
      chatJid: 'discord:parent',
      groupName: 'thread',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });
    const options = { threadId: 'thread', generation: 29 };

    const stale = sender('Still working', {
      ...options,
      replaceOnly: true,
    });
    const deliveryReady = sender.beforeVisibleDelivery(options);
    await vi.advanceTimersByTimeAsync(2_000);
    await deliveryReady;
    sender.recordVisibleDelivery('Done.', { ...options, done: true });

    await vi.advanceTimersByTimeAsync(3_000);
    stalled.resolve(true);
    await stale;
    await flushMicrotasks();

    expect(calls).toEqual(['Still working', 'Done.']);
  });

  it('does not loop immediately when a repair fails', async () => {
    const stalled = deferred<boolean>();
    const calls: string[] = [];
    const sender = createProgressChannelSender({
      channelRuntime: {
        sendProgressUpdate: vi.fn(async (_jid: string, text: string) => {
          calls.push(text);
          if (calls.length === 1) return stalled.promise;
          if (text === 'Failed update.') {
            return false;
          }
          return true;
        }),
      } as never,
      chatJid: 'discord:parent',
      groupName: 'thread',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });
    const options = { threadId: 'thread', generation: 31 };

    const stale = sender('Still working', {
      ...options,
      replaceOnly: true,
    });
    const done = sender('Done.', { ...options, done: true });
    await vi.advanceTimersByTimeAsync(2_000);
    await done;

    stalled.resolve(true);
    await stale;
    await flushMicrotasks();
    expect(calls).toEqual(['Still working', 'Done.', 'Done.']);

    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();
    expect(calls).toEqual(['Still working', 'Done.', 'Done.']);

    await expect(
      sender('Failed update.', { ...options, done: true }),
    ).resolves.toBe(false);
    await flushMicrotasks();

    expect(calls).toEqual([
      'Still working',
      'Done.',
      'Done.',
      'Failed update.',
      'Failed update.',
    ]);
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();
    expect(calls).toEqual([
      'Still working',
      'Done.',
      'Done.',
      'Failed update.',
      'Failed update.',
      'Failed update.',
      'Failed update.',
    ]);
  });

  it('reasserts the current turn when an old-turn edit lands late', async () => {
    const oldStall = deferred<boolean>();
    const calls: string[] = [];
    const options = {
      providerAccountId: 'account-retirement',
      threadId: 'thread-retirement',
      generation: 37,
    };
    const channelRuntime = {
      sendProgressUpdate: vi.fn(async (_jid: string, text: string) => {
        calls.push(text);
        if (calls.length === 1) return oldStall.promise;
        return true;
      }),
    } as never;
    const oldSender = createProgressChannelSender({
      channelRuntime,
      chatJid: 'discord:retirement-parent',
      groupName: 'old-turn',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });
    const stale = oldSender('Still working', {
      ...options,
      replaceOnly: true,
    });
    const newSender = createProgressChannelSender({
      channelRuntime,
      chatJid: 'discord:retirement-parent',
      groupName: 'new-turn',
      providerAccountId: options.providerAccountId,
      threadId: options.threadId,
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });
    const current = newSender('Working', options);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(current).resolves.toBe(true);
    oldStall.resolve(true);
    await expect(stale).resolves.toBe(true);
    await flushMicrotasks();

    expect(calls).toEqual(['Still working', 'Working', 'Working']);
    await expect(oldSender('Done.', { ...options, done: true })).resolves.toBe(
      false,
    );
    expect(calls).toEqual(['Still working', 'Working', 'Working']);
  });

  it('keeps terminal state repairable after its sender retires', async () => {
    const stalled = deferred<boolean>();
    const calls: string[] = [];
    const channelRuntime = {
      sendProgressUpdate: vi.fn(async (_jid: string, text: string) => {
        calls.push(text);
        if (text === 'Still working') return stalled.promise;
        return true;
      }),
    } as never;
    const sender = createProgressChannelSender({
      channelRuntime,
      chatJid: 'discord:terminal-retirement',
      groupName: 'thread',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });
    const options = { threadId: 'thread', generation: 41 };

    const stale = sender('Still working', {
      ...options,
      replaceOnly: true,
    });
    const done = sender('Done.', { ...options, done: true });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(done).resolves.toBe(true);
    sender.retire();

    stalled.resolve(true);
    await expect(stale).resolves.toBe(true);
    await flushMicrotasks();

    expect(calls).toEqual(['Still working', 'Done.', 'Done.']);
    expect(progressOrderingRegistrySize(channelRuntime)).toBe(0);
  });

  it('garbage-collects a card registry entry once every link is settled', async () => {
    const pending = deferred<boolean>();
    const channelRuntime = {
      sendProgressUpdate: vi.fn(async () => pending.promise),
    } as never;
    const sender = createProgressChannelSender({
      channelRuntime,
      chatJid: 'discord:registry-gc',
      groupName: 'thread',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });

    const send = sender('Working', { threadId: 'thread', generation: 42 });
    expect(progressOrderingRegistrySize(channelRuntime)).toBe(1);

    pending.resolve(true);
    await expect(send).resolves.toBe(true);
    await flushMicrotasks();

    expect(progressOrderingRegistrySize(channelRuntime)).toBe(0);
  });

  it('charges a hung progress link timeout only once across streaming deliveries', async () => {
    const neverSettles = new Promise<boolean>(() => undefined);
    const sender = createProgressChannelSender({
      channelRuntime: {
        sendProgressUpdate: vi.fn(async () => neverSettles),
      } as never,
      chatJid: 'discord:non-blocking-link',
      groupName: 'thread',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });
    const options = { threadId: 'thread', generation: 43 };
    void sender('Working', options);

    const firstChunk = sender.beforeVisibleDelivery(options);
    await vi.advanceTimersByTimeAsync(1_999);
    let firstChunkReady = false;
    void firstChunk.then(() => {
      firstChunkReady = true;
    });
    await flushMicrotasks();
    expect(firstChunkReady).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await firstChunk;
    for (let chunk = 0; chunk < 5; chunk += 1) {
      await expect(
        sender.beforeVisibleDelivery(options),
      ).resolves.toBeUndefined();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never repairs a nonterminal update suppressed by the finalizing guard', async () => {
    const calls: string[] = [];
    const finalizingGenerations = new Set<number>();
    const sender = createProgressChannelSender({
      channelRuntime: {
        sendProgressUpdate: vi.fn(async (_jid: string, text: string) => {
          calls.push(text);
          return true;
        }),
      } as never,
      chatJid: 'discord:finalizing-guard',
      groupName: 'thread',
      finalizingGenerations,
      log: { warn: vi.fn() },
    });
    const options = { threadId: 'thread', generation: 47 };

    await expect(sender('Done.', { ...options, done: true })).resolves.toBe(
      true,
    );
    finalizingGenerations.add(options.generation);
    await expect(sender('Suppressed update.', options)).resolves.toBe(false);
    await flushMicrotasks();

    expect(calls).toEqual(['Done.']);
  });

  it('drops an older queued update after newer visible state completes', async () => {
    const first = deferred<boolean>();
    const calls: string[] = [];
    const sender = createProgressChannelSender({
      channelRuntime: {
        sendProgressUpdate: vi.fn(async (_jid: string, text: string) => {
          calls.push(text);
          return text === 'Working' ? first.promise : true;
        }),
      } as never,
      chatJid: 'discord:visible-wins',
      groupName: 'thread',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });
    const options = { threadId: 'thread', generation: 48 };

    const working = sender('Working', options);
    const queued = sender('Older queued update.', options);
    sender.recordVisibleDelivery('Visible response.', options);
    first.resolve(true);

    await expect(working).resolves.toBe(true);
    await expect(queued).resolves.toBe(false);
    await flushMicrotasks();
    expect(calls).toEqual(['Working', 'Visible response.']);
  });

  it('does not reconcile an update that wakes after its owner retires', async () => {
    const first = deferred<boolean>();
    const calls: string[] = [];
    const sender = createProgressChannelSender({
      channelRuntime: {
        sendProgressUpdate: vi.fn(async (_jid: string, text: string) => {
          calls.push(text);
          return text === 'Working' ? first.promise : true;
        }),
      } as never,
      chatJid: 'discord:retired-guard',
      groupName: 'thread',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });
    const options = { threadId: 'thread', generation: 49 };

    const working = sender('Working', options);
    const queued = sender('Queued update.', options);
    sender.retire();
    first.resolve(true);

    await expect(working).resolves.toBe(true);
    await expect(queued).resolves.toBe(false);
    await flushMicrotasks();
    expect(calls).toEqual(['Working']);
  });

  it('detaches a never-settling repair so a later original can reconcile', async () => {
    const firstOld = deferred<boolean>();
    const secondOld = deferred<boolean>();
    const neverSettlingRepair = new Promise<boolean>(() => undefined);
    const calls: string[] = [];
    const sender = createProgressChannelSender({
      channelRuntime: {
        sendProgressUpdate: vi.fn(async (_jid: string, text: string) => {
          calls.push(text);
          if (calls.length === 1) return firstOld.promise;
          if (calls.length === 2) return secondOld.promise;
          if (calls.length === 4) return neverSettlingRepair;
          return true;
        }),
      } as never,
      chatJid: 'discord:detached-repair',
      groupName: 'thread',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });
    const options = { threadId: 'thread', generation: 51 };

    const first = sender('Old state one.', options);
    const second = sender('Old state two.', options);
    const done = sender('Done.', { ...options, done: true });
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(done).resolves.toBe(true);

    firstOld.resolve(true);
    await expect(first).resolves.toBe(true);
    await flushMicrotasks();
    expect(calls).toHaveLength(4);

    await vi.advanceTimersByTimeAsync(2_000);
    secondOld.resolve(true);
    await expect(second).resolves.toBe(true);
    await flushMicrotasks();

    expect(calls).toEqual([
      'Old state one.',
      'Old state two.',
      'Done.',
      'Done.',
      'Done.',
    ]);
  });

  it('retains a retired card until its abandoned link settles and is repaired', async () => {
    const stalled = deferred<boolean>();
    const calls: string[] = [];
    const channelRuntime = {
      sendProgressUpdate: vi.fn(async (_jid: string, text: string) => {
        calls.push(text);
        return text === 'Still working' ? stalled.promise : true;
      }),
    } as never;
    const sender = createProgressChannelSender({
      channelRuntime,
      chatJid: 'discord:abandoned-registry-gc',
      groupName: 'thread',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });
    const options = { threadId: 'thread', generation: 53 };

    const stall = sender('Still working', options);
    const done = sender('Done.', { ...options, done: true });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(done).resolves.toBe(true);
    sender.retire();
    await vi.advanceTimersByTimeAsync(2_000);
    await flushMicrotasks();

    expect(progressOrderingRegistrySize(channelRuntime)).toBe(1);

    stalled.resolve(true);
    await expect(stall).resolves.toBe(true);
    await flushMicrotasks();

    expect(calls).toEqual(['Still working', 'Done.', 'Done.']);
    expect(progressOrderingRegistrySize(channelRuntime)).toBe(0);
  });

  it('retries a failed repair with bounded backoff and restores terminal state', async () => {
    const stalled = deferred<boolean>();
    const calls: string[] = [];
    let repairAttempts = 0;
    const channelRuntime = {
      sendProgressUpdate: vi.fn(async (_jid: string, text: string) => {
        calls.push(text);
        if (text === 'Still working') return stalled.promise;
        if (calls.length > 2 && repairAttempts++ === 0) return false;
        return true;
      }),
    } as never;
    const sender = createProgressChannelSender({
      channelRuntime,
      chatJid: 'discord:repair-backoff',
      groupName: 'thread',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });
    const options = { threadId: 'thread', generation: 59 };

    const stall = sender('Still working', options);
    const done = sender('Done.', { ...options, done: true });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(done).resolves.toBe(true);
    stalled.resolve(true);
    await expect(stall).resolves.toBe(true);
    await flushMicrotasks();
    expect(calls).toEqual(['Still working', 'Done.', 'Done.']);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    expect(calls).toEqual(['Still working', 'Done.', 'Done.', 'Done.']);
  });

  it('stops after two delayed retries when repairs keep failing', async () => {
    const stalled = deferred<boolean>();
    const calls: string[] = [];
    const channelRuntime = {
      sendProgressUpdate: vi.fn(async (_jid: string, text: string) => {
        calls.push(text);
        if (text === 'Still working') return stalled.promise;
        return calls.length === 2;
      }),
    } as never;
    const sender = createProgressChannelSender({
      channelRuntime,
      chatJid: 'discord:repair-backoff-cap',
      groupName: 'thread',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });
    const options = { threadId: 'thread', generation: 61 };

    const stall = sender('Still working', options);
    const done = sender('Done.', { ...options, done: true });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(done).resolves.toBe(true);
    stalled.resolve(true);
    await expect(stall).resolves.toBe(true);
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(35_000);
    await flushMicrotasks();
    expect(calls).toEqual([
      'Still working',
      'Done.',
      'Done.',
      'Done.',
      'Done.',
    ]);

    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();
    expect(calls).toHaveLength(5);
  });

  it('resets the retry budget after a successful repair settlement', async () => {
    const firstStale = deferred<boolean>();
    const secondStale = deferred<boolean>();
    const calls: string[] = [];
    const doneResults = [true, false, false, true, false, true];
    const channelRuntime = {
      sendProgressUpdate: vi.fn(async (_jid: string, text: string) => {
        calls.push(text);
        if (text === 'Stale A') return firstStale.promise;
        if (text === 'Stale B') return secondStale.promise;
        return doneResults.shift() ?? true;
      }),
    } as never;
    const sender = createProgressChannelSender({
      channelRuntime,
      chatJid: 'discord:repair-budget-reset',
      groupName: 'thread',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });
    const options = { threadId: 'thread', generation: 62 };

    const first = sender('Stale A', options);
    const second = sender('Stale B', options);
    const done = sender('Done.', { ...options, done: true });
    await vi.advanceTimersByTimeAsync(4_000);
    await expect(done).resolves.toBe(true);

    firstStale.resolve(true);
    await expect(first).resolves.toBe(true);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await flushMicrotasks();
    expect(calls).toEqual([
      'Stale A',
      'Stale B',
      'Done.',
      'Done.',
      'Done.',
      'Done.',
    ]);

    secondStale.resolve(true);
    await expect(second).resolves.toBe(true);
    await flushMicrotasks();
    expect(calls).toHaveLength(7);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(calls).toHaveLength(7);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    expect(calls).toEqual([
      'Stale A',
      'Stale B',
      'Done.',
      'Done.',
      'Done.',
      'Done.',
      'Done.',
      'Done.',
    ]);
  });

  it('backs off after an abandoned repair without waiting for it to settle', async () => {
    const stalled = deferred<boolean>();
    const hungRepair = deferred<boolean>();
    const calls: string[] = [];
    const channelRuntime = {
      sendProgressUpdate: vi.fn(async (_jid: string, text: string) => {
        calls.push(text);
        if (text === 'Still working') return stalled.promise;
        if (calls.length === 3) return hungRepair.promise;
        return true;
      }),
    } as never;
    const sender = createProgressChannelSender({
      channelRuntime,
      chatJid: 'discord:abandoned-repair-backoff',
      groupName: 'thread',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });
    const options = { threadId: 'thread', generation: 63 };

    const stall = sender('Still working', options);
    const done = sender('Done.', { ...options, done: true });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(done).resolves.toBe(true);
    stalled.resolve(true);
    await expect(stall).resolves.toBe(true);
    await flushMicrotasks();
    expect(calls).toEqual(['Still working', 'Done.', 'Done.']);

    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    expect(calls).toEqual(['Still working', 'Done.', 'Done.', 'Done.']);
  });

  it('keeps a desired payload retry scheduled when an older original settles', async () => {
    const stalled = deferred<boolean>();
    const calls: string[] = [];
    const channelRuntime = {
      sendProgressUpdate: vi.fn(async (_jid: string, text: string) => {
        calls.push(text);
        if (text === 'Still working') return stalled.promise;
        return calls.length >= 4;
      }),
    } as never;
    const sender = createProgressChannelSender({
      channelRuntime,
      chatJid: 'discord:stale-settlement-retry-episode',
      groupName: 'thread',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });
    const options = { threadId: 'thread', generation: 65 };

    const stall = sender('Still working', options);
    const done = sender('Done.', { ...options, done: true });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(done).resolves.toBe(false);
    await flushMicrotasks();
    expect(calls).toEqual(['Still working', 'Done.', 'Done.']);

    stalled.resolve(false);
    await expect(stall).resolves.toBe(false);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    await flushMicrotasks();

    expect(calls).toEqual(['Still working', 'Done.', 'Done.', 'Done.']);
  });

  it('keeps a retired card registered while its repair retry is scheduled', async () => {
    const calls: string[] = [];
    const channelRuntime = {
      sendProgressUpdate: vi.fn(async (_jid: string, text: string) => {
        calls.push(text);
        return calls.length >= 3;
      }),
    } as never;
    const sender = createProgressChannelSender({
      channelRuntime,
      chatJid: 'discord:retired-repair-retry',
      groupName: 'thread',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });
    const options = { threadId: 'thread', generation: 66 };

    await expect(sender('Done.', { ...options, done: true })).resolves.toBe(
      false,
    );
    await flushMicrotasks();
    expect(calls).toEqual(['Done.', 'Done.']);

    sender.retire();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(progressOrderingRegistrySize(channelRuntime)).toBe(1);

    await vi.advanceTimersByTimeAsync(3_000);
    await flushMicrotasks();
    expect(calls).toEqual(['Done.', 'Done.', 'Done.']);
    expect(progressOrderingRegistrySize(channelRuntime)).toBe(0);
  });

  it('force-releases a retired tombstone after ten minutes', async () => {
    const stalled = deferred<boolean>();
    const calls: string[] = [];
    const channelRuntime = {
      sendProgressUpdate: vi.fn(async (_jid: string, text: string) => {
        calls.push(text);
        return text === 'Still working' ? stalled.promise : true;
      }),
    } as never;
    const sender = createProgressChannelSender({
      channelRuntime,
      chatJid: 'discord:tombstone-cap',
      groupName: 'thread',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });
    const options = { threadId: 'thread', generation: 67 };

    const stall = sender('Still working', options);
    const done = sender('Done.', { ...options, done: true });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(done).resolves.toBe(true);
    sender.retire();

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(progressOrderingRegistrySize(channelRuntime)).toBe(0);

    stalled.resolve(true);
    await expect(stall).resolves.toBe(true);
    await flushMicrotasks();
    expect(calls).toEqual(['Still working', 'Done.']);
    expect(progressOrderingRegistrySize(channelRuntime)).toBe(0);
  });

  it('force-releases a retired card whose only send never settles', async () => {
    const stalled = deferred<boolean>();
    const calls: string[] = [];
    const channelRuntime = {
      sendProgressUpdate: vi.fn(async (_jid: string, text: string) => {
        calls.push(text);
        return stalled.promise;
      }),
    } as never;
    const sender = createProgressChannelSender({
      channelRuntime,
      chatJid: 'discord:lone-hung-retention-cap',
      groupName: 'thread',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });
    const options = { threadId: 'thread', generation: 68 };

    const stall = sender('Still working', options);
    await flushMicrotasks();
    sender.retire();

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(progressOrderingRegistrySize(channelRuntime)).toBe(0);

    stalled.resolve(true);
    await expect(stall).resolves.toBe(true);
    await flushMicrotasks();
    expect(calls).toEqual(['Still working']);
    expect(progressOrderingRegistrySize(channelRuntime)).toBe(0);
  });

  it('gives a successor owner a fresh retention window', async () => {
    const stalled = deferred<boolean>();
    const channelRuntime = {
      sendProgressUpdate: vi.fn(async () => stalled.promise),
    } as never;
    const options = { threadId: 'thread', generation: 69 };
    const firstSender = createProgressChannelSender({
      channelRuntime,
      chatJid: 'discord:retention-epoch',
      groupName: 'first turn',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });

    const firstSend = firstSender('Still working', options);
    await flushMicrotasks();
    firstSender.retire();
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    const secondSender = createProgressChannelSender({
      channelRuntime,
      chatJid: 'discord:retention-epoch',
      groupName: 'second turn',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });
    secondSender.recordVisibleDelivery('Visible response.', options);
    secondSender.retire();

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(progressOrderingRegistrySize(channelRuntime)).toBe(1);
    await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
    expect(progressOrderingRegistrySize(channelRuntime)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(progressOrderingRegistrySize(channelRuntime)).toBe(0);

    stalled.resolve(true);
    await expect(firstSend).resolves.toBe(true);
    await flushMicrotasks();
    expect(progressOrderingRegistrySize(channelRuntime)).toBe(0);
  });
});
