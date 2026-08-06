import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createProgressChannelSender,
  progressCardIdentityCacheSize,
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

  it('supersedes an undispatched stall without duplicating terminal dispatch', async () => {
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
    expect(sendProgressUpdate).toHaveBeenCalledTimes(2);
    expect(
      sendProgressUpdate.mock.calls.filter(([, text]) => text === 'Done.'),
    ).toHaveLength(1);
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

  it('repairs a late provider-card generation without touching the next generation card', async () => {
    const oldEdit = deferred<boolean>();
    const calls: Array<{ text: string; generation?: number }> = [];
    const channelRuntime = {
      progressCardIdentity: vi.fn(
        (_jid: string, options?: { generation?: number }) =>
          `discord-generation-${options?.generation ?? ''}`,
      ),
      sendProgressUpdate: vi.fn(
        async (
          _jid: string,
          text: string,
          options?: { generation?: number },
        ) => {
          calls.push({ text, generation: options?.generation });
          if (text === 'Still working') return oldEdit.promise;
          return true;
        },
      ),
    } as never;
    const sender = createProgressChannelSender({
      channelRuntime,
      chatJid: 'discord:generation-key',
      groupName: 'thread',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });

    const stale = sender('Still working', {
      threadId: 'thread',
      generation: 70,
      replaceOnly: true,
    });
    const oldDone = sender('Done generation 70.', {
      threadId: 'thread',
      generation: 70,
      done: true,
    });
    const next = sender('Working generation 71.', {
      threadId: 'thread',
      generation: 71,
    });

    await expect(next).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(oldDone).resolves.toBe(true);
    oldEdit.resolve(true);
    await expect(stale).resolves.toBe(true);
    await flushMicrotasks();

    expect(calls).toEqual([
      { text: 'Still working', generation: 70 },
      { text: 'Working generation 71.', generation: 71 },
      { text: 'Done generation 70.', generation: 70 },
      { text: 'Done generation 70.', generation: 70 },
    ]);
  });

  it('reconciles a late Slack edit to the newest route-scoped terminal state', async () => {
    const oldEdit = deferred<boolean>();
    const calls: Array<{
      text: string;
      generation?: number;
      replaceOnly?: boolean;
    }> = [];
    const channelRuntime = {
      progressCardIdentity: vi.fn(() => undefined),
      sendProgressUpdate: vi.fn(
        async (
          _jid: string,
          text: string,
          options?: { generation?: number; replaceOnly?: boolean },
        ) => {
          calls.push({
            text,
            generation: options?.generation,
            replaceOnly: options?.replaceOnly,
          });
          if (text === 'Still working') return oldEdit.promise;
          return true;
        },
      ),
    } as never;
    const sender = createProgressChannelSender({
      channelRuntime,
      chatJid: 'slack:channel',
      groupName: 'thread',
      providerAccountId: 'slack-account',
      threadId: 'thread',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });

    const stale = sender('Still working', {
      generation: 1,
      replaceOnly: true,
    });
    const retry = sender('retrying 1/3', {
      generation: 2,
      replaceOnly: true,
    });
    const terminal = sender('Done.', { generation: 2, done: true });

    await vi.advanceTimersByTimeAsync(2_000);
    await expect(retry).resolves.toBe(true);
    await expect(terminal).resolves.toBe(true);
    oldEdit.resolve(true);
    await expect(stale).resolves.toBe(true);
    await flushMicrotasks();

    expect(calls.map(({ text }) => text)).toEqual([
      'Still working',
      'retrying 1/3',
      'Done.',
      'Done.',
    ]);
  });

  it('serializes stop-card generations by provider identity and never reposts a missing terminal card', async () => {
    const oldStop = deferred<boolean>();
    const calls: Array<{
      text: string;
      generation?: number;
      replaceOnly?: boolean;
    }> = [];
    const providerDispatches: string[] = [];
    let controlHandleExists = false;
    const channelRuntime = {
      progressCardIdentity: vi.fn(
        (
          _jid: string,
          options?: {
            done?: boolean;
            generation?: number;
            actionAffordances?: Array<{ kind: string }>;
          },
        ) => {
          const hasStop = options?.actionAffordances?.some(
            (action) => action.kind === 'live_turn_stop',
          );
          return hasStop || (options?.done && controlHandleExists)
            ? 'discord-control'
            : `discord-generation-${options?.generation ?? ''}`;
        },
      ),
      sendProgressUpdate: vi.fn(
        async (
          _jid: string,
          text: string,
          options?: {
            done?: boolean;
            generation?: number;
            replaceOnly?: boolean;
          },
        ) => {
          calls.push({
            text,
            generation: options?.generation,
            replaceOnly: options?.replaceOnly,
          });
          if (options?.replaceOnly && !controlHandleExists) return false;
          providerDispatches.push(text);
          if (text === 'Working generation 70.') {
            controlHandleExists = true;
            return oldStop.promise;
          }
          controlHandleExists = options?.done !== true;
          return true;
        },
      ),
    } as never;
    const sender = createProgressChannelSender({
      channelRuntime,
      chatJid: 'discord:control-generation',
      groupName: 'thread',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });
    const stopAction = [
      {
        kind: 'live_turn_stop' as const,
        label: 'Stop',
        actionToken: 'stop-token',
      },
    ];

    const stale = sender('Working generation 70.', {
      threadId: 'thread',
      generation: 70,
      actionAffordances: stopAction,
    });
    const retry = sender('retrying 1/3', {
      threadId: 'thread',
      generation: 71,
      actionAffordances: stopAction,
    });
    await flushMicrotasks();
    expect(providerDispatches).toEqual(['Working generation 70.']);

    await vi.advanceTimersByTimeAsync(2_000);
    await expect(retry).resolves.toBe(true);
    expect(providerDispatches).toEqual([
      'Working generation 70.',
      'retrying 1/3',
    ]);

    await expect(
      sender('Done.', {
        threadId: 'thread',
        generation: 71,
        done: true,
      }),
    ).resolves.toBe(true);
    expect(providerDispatches).toEqual([
      'Working generation 70.',
      'retrying 1/3',
      'Done.',
    ]);

    oldStop.resolve(true);
    await expect(stale).resolves.toBe(true);
    await flushMicrotasks();

    expect(providerDispatches).toEqual([
      'Working generation 70.',
      'retrying 1/3',
      'Done.',
    ]);
    expect(calls.at(-1)).toEqual({
      text: 'Done.',
      generation: 71,
      replaceOnly: true,
    });
  });

  it('serializes generationless stop and done updates on one control-card key', async () => {
    const first = deferred<boolean>();
    const calls: string[] = [];
    const sender = createProgressChannelSender({
      channelRuntime: {
        progressCardIdentity: vi.fn(
          (
            _jid: string,
            options?: {
              done?: boolean;
              actionAffordances?: Array<{ kind: string }>;
            },
          ) =>
            options?.actionAffordances?.some(
              (action) => action.kind === 'live_turn_stop',
            )
              ? 'discord-control'
              : 'discord-generationless',
        ),
        sendProgressUpdate: vi.fn(async (_jid: string, text: string) => {
          calls.push(text);
          if (text === 'Generationless stop') return first.promise;
          return true;
        }),
      } as never,
      chatJid: 'discord:shared-control',
      groupName: 'thread',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });
    const stopAction = [
      {
        kind: 'live_turn_stop' as const,
        label: 'Stop',
        actionToken: 'stop-token',
      },
    ];

    const stop = sender('Generationless stop', {
      threadId: 'thread',
      actionAffordances: stopAction,
    });
    const done = sender('Generationless done', {
      threadId: 'thread',
      done: true,
    });
    await flushMicrotasks();
    expect(calls).toEqual(['Generationless stop']);

    first.resolve(true);
    await expect(stop).resolves.toBe(true);
    await expect(done).resolves.toBe(true);
    expect(calls).toEqual(['Generationless stop', 'Generationless done']);
  });

  it('keeps equal generation numbers independent across provider routes', async () => {
    const routeAStop = deferred<boolean>();
    const routeBStop = deferred<boolean>();
    const calls: string[] = [];
    const sender = createProgressChannelSender({
      channelRuntime: {
        progressCardIdentity: vi.fn(
          (
            _jid: string,
            options?: {
              providerAccountId?: string;
              threadId?: string;
              actionAffordances?: Array<{ kind: string }>;
            },
          ) =>
            options?.actionAffordances?.some(
              (action) => action.kind === 'live_turn_stop',
            )
              ? `control:${options.providerAccountId}:${options.threadId}`
              : `generation:${options.providerAccountId}:${options.threadId}`,
        ),
        sendProgressUpdate: vi.fn(async (_jid: string, text: string) => {
          calls.push(text);
          if (text === 'Route A stop') return routeAStop.promise;
          if (text === 'Route B stop') return routeBStop.promise;
          return true;
        }),
      } as never,
      chatJid: 'discord:shared-parent',
      groupName: 'thread',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });
    const stopAction = [
      {
        kind: 'live_turn_stop' as const,
        label: 'Stop',
        actionToken: 'stop-token',
      },
    ];
    const routeA = {
      providerAccountId: 'account-a',
      threadId: 'thread-a',
      generation: 1,
    };
    const routeB = {
      providerAccountId: 'account-b',
      threadId: 'thread-b',
      generation: 1,
    };

    const stopA = sender('Route A stop', {
      ...routeA,
      actionAffordances: stopAction,
    });
    const stopB = sender('Route B stop', {
      ...routeB,
      actionAffordances: stopAction,
    });
    const doneA = sender('Route A done', { ...routeA, done: true });
    await flushMicrotasks();
    expect(calls).toEqual(['Route A stop', 'Route B stop']);

    routeAStop.resolve(true);
    await expect(stopA).resolves.toBe(true);
    await expect(doneA).resolves.toBe(true);
    expect(calls).toEqual(['Route A stop', 'Route B stop', 'Route A done']);

    routeBStop.resolve(true);
    await expect(stopB).resolves.toBe(true);
  });

  it('keeps equal generations independent across non-threaded chats', async () => {
    const chatAStop = deferred<boolean>();
    const chatBStop = deferred<boolean>();
    const calls: Array<{ jid: string; text: string }> = [];
    const channelRuntime = {
      progressCardIdentity: vi.fn(
        (
          jid: string,
          options?: {
            generation?: number;
            actionAffordances?: Array<{ kind: string }>;
          },
        ) =>
          options?.actionAffordances?.some(
            (action) => action.kind === 'live_turn_stop',
          )
            ? `control:${jid}`
            : `generation:${jid}:${options?.generation ?? ''}`,
      ),
      sendProgressUpdate: vi.fn(async (jid: string, text: string) => {
        calls.push({ jid, text });
        if (text === 'Chat A stop') return chatAStop.promise;
        if (text === 'Chat B stop') return chatBStop.promise;
        return true;
      }),
    } as never;
    const stopAction = [
      {
        kind: 'live_turn_stop' as const,
        label: 'Stop',
        actionToken: 'stop-token',
      },
    ];
    const senderA = createProgressChannelSender({
      channelRuntime,
      chatJid: 'discord:chat-a',
      groupName: 'chat a',
      providerAccountId: 'shared-account',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });
    const senderB = createProgressChannelSender({
      channelRuntime,
      chatJid: 'discord:chat-b',
      groupName: 'chat b',
      providerAccountId: 'shared-account',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });

    const stopA = senderA('Chat A stop', {
      generation: 1,
      actionAffordances: stopAction,
    });
    const stopB = senderB('Chat B stop', {
      generation: 1,
      actionAffordances: stopAction,
    });
    const doneA = senderA('Chat A done', { generation: 1, done: true });
    const doneB = senderB('Chat B done', { generation: 1, done: true });
    await flushMicrotasks();

    expect(calls).toEqual([
      { jid: 'discord:chat-a', text: 'Chat A stop' },
      { jid: 'discord:chat-b', text: 'Chat B stop' },
    ]);

    chatAStop.resolve(true);
    await expect(stopA).resolves.toBe(true);
    await expect(doneA).resolves.toBe(true);
    expect(calls).toEqual([
      { jid: 'discord:chat-a', text: 'Chat A stop' },
      { jid: 'discord:chat-b', text: 'Chat B stop' },
      { jid: 'discord:chat-a', text: 'Chat A done' },
    ]);

    chatBStop.resolve(true);
    await expect(stopB).resolves.toBe(true);
    await expect(doneB).resolves.toBe(true);
  });

  it('normalizes the configured thread before resolving provider-card identity', async () => {
    const first = deferred<boolean>();
    const calls: string[] = [];
    const progressCardIdentity = vi.fn(
      (_jid: string, options?: { threadId?: string }) =>
        `identity:${options?.threadId ?? 'parent'}`,
    );
    const sender = createProgressChannelSender({
      channelRuntime: {
        progressCardIdentity,
        sendProgressUpdate: vi.fn(async (_jid: string, text: string) => {
          calls.push(text);
          if (text === 'Configured thread') return first.promise;
          return true;
        }),
      } as never,
      chatJid: 'discord:configured-thread',
      groupName: 'thread',
      threadId: 'thread-1',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });

    const configured = sender('Configured thread');
    const explicit = sender('Explicit thread', { threadId: 'thread-1' });
    await flushMicrotasks();

    expect(progressCardIdentity).toHaveBeenNthCalledWith(
      1,
      'discord:configured-thread',
      { threadId: 'thread-1' },
    );
    expect(calls).toEqual(['Configured thread']);

    first.resolve(true);
    await expect(configured).resolves.toBe(true);
    await expect(explicit).resolves.toBe(true);
    expect(calls).toEqual(['Configured thread', 'Explicit thread']);
  });

  it('dispatches configured account and thread defaults for an optionless update', async () => {
    const sendProgressUpdate = vi.fn(async () => true);
    const sender = createProgressChannelSender({
      channelRuntime: {
        progressCardIdentity: vi.fn(() => 'configured-route-card'),
        sendProgressUpdate,
      } as never,
      chatJid: 'discord:configured-route',
      groupName: 'thread',
      providerAccountId: 'account-1',
      threadId: 'thread-1',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });

    await expect(sender('Configured route')).resolves.toBe(true);

    expect(sendProgressUpdate).toHaveBeenCalledWith(
      'discord:configured-route',
      'Configured route',
      {
        providerAccountId: 'account-1',
        threadId: 'thread-1',
        progressCardIdentity: 'configured-route-card',
      },
    );
  });

  it.each([
    ['cached', 0, 1],
    ['live after cache expiry', 10 * 60_000, 0],
  ] as const)(
    'targets the %s stop card for nonterminal stall and retry edits',
    async (_source, cacheAgeMs, expectedCacheSize) => {
      const calls: Array<{ text: string; identity?: string }> = [];
      let controlHandleExists = false;
      const channelRuntime = {
        progressCardIdentity: vi.fn(
          (
            _jid: string,
            options?: {
              done?: boolean;
              generation?: number;
              actionAffordances?: Array<{ kind: string }>;
            },
          ) => {
            const hasStop = options?.actionAffordances?.some(
              (action) => action.kind === 'live_turn_stop',
            );
            return hasStop || (options?.done && controlHandleExists)
              ? 'discord-control'
              : `discord-generation-${options?.generation ?? ''}`;
          },
        ),
        sendProgressUpdate: vi.fn(
          async (
            _jid: string,
            text: string,
            options?: {
              progressCardIdentity?: string;
              replaceOnly?: boolean;
            },
          ) => {
            calls.push({ text, identity: options?.progressCardIdentity });
            if (text === 'Stop') controlHandleExists = true;
            return (
              !options?.replaceOnly ||
              options.progressCardIdentity === 'discord-control'
            );
          },
        ),
      } as never;
      const sender = createProgressChannelSender({
        channelRuntime,
        chatJid: `discord:nonterminal-control-${cacheAgeMs}`,
        groupName: 'thread',
        finalizingGenerations: new Set<number>(),
        log: { warn: vi.fn() },
      });

      await sender('Stop', {
        generation: 1,
        actionAffordances: [
          {
            kind: 'live_turn_stop',
            label: 'Stop',
            actionToken: 'stop-token',
          },
        ],
      });
      if (cacheAgeMs) await vi.advanceTimersByTimeAsync(cacheAgeMs);
      expect(progressCardIdentityCacheSize(channelRuntime)).toBe(
        expectedCacheSize,
      );

      await expect(
        sender('Still working', { generation: 1, replaceOnly: true }),
      ).resolves.toBe(true);
      await expect(
        sender('retrying 1/3', { generation: 1, replaceOnly: true }),
      ).resolves.toBe(true);
      expect(calls).toEqual([
        { text: 'Stop', identity: 'discord-control' },
        { text: 'Still working', identity: 'discord-control' },
        { text: 'retrying 1/3', identity: 'discord-control' },
      ]);
    },
  );

  it('keeps an older nonterminal edit off a newer cached control card', async () => {
    const calls: Array<{ text: string; identity?: string }> = [];
    const channelRuntime = {
      progressCardIdentity: vi.fn(
        (
          _jid: string,
          options?: {
            done?: boolean;
            generation?: number;
            actionAffordances?: Array<{ kind: string }>;
          },
        ) =>
          options?.actionAffordances?.some(
            (action) => action.kind === 'live_turn_stop',
          ) || options?.done
            ? 'discord-control'
            : `discord-generation-${options?.generation ?? ''}`,
      ),
      sendProgressUpdate: vi.fn(
        async (
          _jid: string,
          text: string,
          options?: { progressCardIdentity?: string; replaceOnly?: boolean },
        ) => {
          calls.push({ text, identity: options?.progressCardIdentity });
          return options?.replaceOnly !== true;
        },
      ),
    } as never;
    const sender = createProgressChannelSender({
      channelRuntime,
      chatJid: 'discord:older-nonterminal',
      groupName: 'thread',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });

    await sender('Stop generation 2', {
      generation: 2,
      actionAffordances: [
        {
          kind: 'live_turn_stop',
          label: 'Stop',
          actionToken: 'stop-token-2',
        },
      ],
    });
    await expect(
      sender('Still working generation 1', {
        generation: 1,
        replaceOnly: true,
      }),
    ).resolves.toBe(false);

    expect(calls.slice(1)).toEqual(
      calls.slice(1).map(() => ({
        text: 'Still working generation 1',
        identity: 'discord-generation-1',
      })),
    );
  });

  it('retains a landed stop identity after chain quiescence until a later terminal lands', async () => {
    const calls: Array<{ text: string; identity?: string }> = [];
    const channelRuntime = {
      progressCardIdentity: vi.fn(
        (
          _jid: string,
          options?: { actionAffordances?: Array<{ kind: string }> },
        ) =>
          options?.actionAffordances?.some(
            (action) => action.kind === 'live_turn_stop',
          )
            ? 'discord-control'
            : 'discord-generation',
      ),
      sendProgressUpdate: vi.fn(
        async (
          _jid: string,
          text: string,
          options?: { progressCardIdentity?: string },
        ) => {
          calls.push({ text, identity: options?.progressCardIdentity });
          return true;
        },
      ),
    } as never;
    const stopSender = createProgressChannelSender({
      channelRuntime,
      chatJid: 'discord:cache-gc',
      groupName: 'stop owner',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });
    await expect(
      stopSender('Stop', {
        generation: 1,
        actionAffordances: [
          {
            kind: 'live_turn_stop',
            label: 'Stop',
            actionToken: 'stop-token',
          },
        ],
      }),
    ).resolves.toBe(true);
    await flushMicrotasks();

    expect(progressOrderingRegistrySize(channelRuntime)).toBe(0);
    expect(progressCardIdentityCacheSize(channelRuntime)).toBe(1);

    const terminalSender = createProgressChannelSender({
      channelRuntime,
      chatJid: 'discord:cache-gc',
      groupName: 'terminal owner',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });
    await expect(
      terminalSender('Done', { generation: 1, done: true }),
    ).resolves.toBe(true);
    await flushMicrotasks();

    expect(calls).toEqual([
      { text: 'Stop', identity: 'discord-control' },
      { text: 'Done', identity: 'discord-control' },
    ]);
    expect(progressOrderingRegistrySize(channelRuntime)).toBe(0);
    expect(progressCardIdentityCacheSize(channelRuntime)).toBe(0);
  });

  it('retires a borrowed control identity after visible terminal delivery', async () => {
    const stopDispatch = deferred<boolean>();
    const calls: Array<{ text: string; identity?: string }> = [];
    const channelRuntime = {
      progressCardIdentity: vi.fn(
        (
          _jid: string,
          options?: {
            generation?: number;
            actionAffordances?: Array<{ kind: string }>;
          },
        ) =>
          options?.actionAffordances?.some(
            (action) => action.kind === 'live_turn_stop',
          )
            ? 'discord-control'
            : `discord-generation-${options?.generation ?? ''}`,
      ),
      sendProgressUpdate: vi.fn(
        async (
          _jid: string,
          text: string,
          options?: { progressCardIdentity?: string },
        ) => {
          calls.push({ text, identity: options?.progressCardIdentity });
          return text === 'Stop' ? stopDispatch.promise : true;
        },
      ),
    } as never;
    const sender = createProgressChannelSender({
      channelRuntime,
      chatJid: 'discord:visible-terminal-cache',
      groupName: 'thread',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });

    const stop = sender('Stop', {
      generation: 1,
      actionAffordances: [
        {
          kind: 'live_turn_stop',
          label: 'Stop',
          actionToken: 'stop-token',
        },
      ],
    });
    await flushMicrotasks();
    expect(progressCardIdentityCacheSize(channelRuntime)).toBe(1);

    sender.recordVisibleDelivery('Done.', { generation: 1, done: true });
    expect(progressCardIdentityCacheSize(channelRuntime)).toBe(0);

    stopDispatch.resolve(true);
    await expect(stop).resolves.toBe(true);
    await flushMicrotasks();
    await sender('Later done', { generation: 2, done: true });
    expect(calls).toEqual([
      { text: 'Stop', identity: 'discord-control' },
      { text: 'Done.', identity: 'discord-control' },
      { text: 'Later done', identity: 'discord-generation-2' },
    ]);
  });

  it('retains the control identity when a stop card lands through repair', async () => {
    let stopAttempts = 0;
    const calls: Array<{ text: string; identity?: string }> = [];
    const channelRuntime = {
      progressCardIdentity: vi.fn(
        (
          _jid: string,
          options?: { actionAffordances?: Array<{ kind: string }> },
        ) =>
          options?.actionAffordances?.some(
            (action) => action.kind === 'live_turn_stop',
          )
            ? 'discord-control'
            : 'discord-generation',
      ),
      sendProgressUpdate: vi.fn(
        async (
          _jid: string,
          text: string,
          options?: { progressCardIdentity?: string },
        ) => {
          calls.push({ text, identity: options?.progressCardIdentity });
          if (text === 'Stop') return ++stopAttempts > 1;
          return true;
        },
      ),
    } as never;
    const sender = createProgressChannelSender({
      channelRuntime,
      chatJid: 'discord:cache-repair',
      groupName: 'thread',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });

    await expect(
      sender('Stop', {
        generation: 1,
        actionAffordances: [
          {
            kind: 'live_turn_stop',
            label: 'Stop',
            actionToken: 'stop-token',
          },
        ],
      }),
    ).resolves.toBe(false);
    await flushMicrotasks();

    expect(calls).toEqual([
      { text: 'Stop', identity: 'discord-control' },
      { text: 'Stop', identity: 'discord-control' },
    ]);
    expect(progressOrderingRegistrySize(channelRuntime)).toBe(0);
    expect(progressCardIdentityCacheSize(channelRuntime)).toBe(1);

    await expect(sender('Done', { generation: 1, done: true })).resolves.toBe(
      true,
    );
    await flushMicrotasks();
    expect(calls.at(-1)).toEqual({
      text: 'Done',
      identity: 'discord-control',
    });
    expect(progressCardIdentityCacheSize(channelRuntime)).toBe(0);
  });

  it('expires a landed stop identity at the independent retention cap', async () => {
    const channelRuntime = {
      progressCardIdentity: vi.fn(
        (
          _jid: string,
          options?: { actionAffordances?: Array<{ kind: string }> },
        ) =>
          options?.actionAffordances?.some(
            (action) => action.kind === 'live_turn_stop',
          )
            ? 'discord-control'
            : 'discord-generation',
      ),
      sendProgressUpdate: vi.fn(async () => true),
    } as never;
    const sender = createProgressChannelSender({
      channelRuntime,
      chatJid: 'discord:cache-retention',
      groupName: 'thread',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });

    await sender('Stop', {
      generation: 1,
      actionAffordances: [
        {
          kind: 'live_turn_stop',
          label: 'Stop',
          actionToken: 'stop-token',
        },
      ],
    });
    await flushMicrotasks();

    expect(progressCardIdentityCacheSize(channelRuntime)).toBe(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
    expect(progressCardIdentityCacheSize(channelRuntime)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    expect(progressOrderingRegistrySize(channelRuntime)).toBe(0);
    expect(progressCardIdentityCacheSize(channelRuntime)).toBe(0);
  });

  it('falls back to the live provider control card after identity retention expires', async () => {
    const calls: Array<{ text: string; identity?: string }> = [];
    let liveControlHandle = false;
    const channelRuntime = {
      progressCardIdentity: vi.fn(
        (
          _jid: string,
          options?: {
            done?: boolean;
            generation?: number;
            actionAffordances?: Array<{ kind: string }>;
          },
        ) => {
          const hasStop = options?.actionAffordances?.some(
            (action) => action.kind === 'live_turn_stop',
          );
          return hasStop || (options?.done && liveControlHandle)
            ? 'discord-control'
            : `discord-generation-${options?.generation ?? ''}`;
        },
      ),
      sendProgressUpdate: vi.fn(
        async (
          _jid: string,
          text: string,
          options?: { done?: boolean; progressCardIdentity?: string },
        ) => {
          calls.push({ text, identity: options?.progressCardIdentity });
          if (text === 'Stop') liveControlHandle = true;
          if (
            options?.done &&
            options.progressCardIdentity === 'discord-control'
          ) {
            liveControlHandle = false;
          }
          return true;
        },
      ),
    } as never;
    const sender = createProgressChannelSender({
      channelRuntime,
      chatJid: 'discord:long-running-turn',
      groupName: 'thread',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });

    await sender('Stop', {
      generation: 1,
      actionAffordances: [
        {
          kind: 'live_turn_stop',
          label: 'Stop',
          actionToken: 'stop-token',
        },
      ],
    });
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(progressCardIdentityCacheSize(channelRuntime)).toBe(0);

    await expect(sender('Done', { generation: 1, done: true })).resolves.toBe(
      true,
    );
    expect(calls).toEqual([
      { text: 'Stop', identity: 'discord-control' },
      { text: 'Done', identity: 'discord-control' },
    ]);
    expect(liveControlHandle).toBe(false);
  });

  it('starts a fresh retention window when a delayed stop card lands', async () => {
    const stopDispatch = deferred<boolean>();
    const channelRuntime = {
      progressCardIdentity: vi.fn(() => 'discord-control'),
      sendProgressUpdate: vi.fn(async () => stopDispatch.promise),
    } as never;
    const sender = createProgressChannelSender({
      channelRuntime,
      chatJid: 'discord:delayed-stop-retention',
      groupName: 'thread',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });

    const stop = sender('Stop', {
      generation: 1,
      actionAffordances: [
        {
          kind: 'live_turn_stop',
          label: 'Stop',
          actionToken: 'stop-token',
        },
      ],
    });
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    stopDispatch.resolve(true);
    await expect(stop).resolves.toBe(true);
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(10 * 60_000 - 1);
    expect(progressCardIdentityCacheSize(channelRuntime)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(progressCardIdentityCacheSize(channelRuntime)).toBe(0);
  });

  it('shares pending control-card identity across sender ownership transfer', async () => {
    const first = deferred<boolean>();
    const calls: string[] = [];
    let controlHandleExists = false;
    const channelRuntime = {
      progressCardIdentity: vi.fn(
        (
          _jid: string,
          options?: {
            done?: boolean;
            generation?: number;
            actionAffordances?: Array<{ kind: string }>;
          },
        ) => {
          const hasStop = options?.actionAffordances?.some(
            (action) => action.kind === 'live_turn_stop',
          );
          return hasStop || (options?.done && controlHandleExists)
            ? 'discord-control'
            : `discord-generation-${options?.generation ?? ''}`;
        },
      ),
      sendProgressUpdate: vi.fn(async (_jid: string, text: string) => {
        calls.push(text);
        if (text === 'Stop generation 1') {
          const landed = await first.promise;
          controlHandleExists = landed;
          return landed;
        }
        if (text === 'Done generation 1') controlHandleExists = false;
        return true;
      }),
    } as never;
    const route = { threadId: 'thread', generation: 1 };
    const stopAction = [
      {
        kind: 'live_turn_stop' as const,
        label: 'Stop',
        actionToken: 'stop-token',
      },
    ];
    const senderA = createProgressChannelSender({
      channelRuntime,
      chatJid: 'discord:owner-transfer',
      groupName: 'first owner',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });

    const stop = senderA('Stop generation 1', {
      ...route,
      actionAffordances: stopAction,
    });
    const senderB = createProgressChannelSender({
      channelRuntime,
      chatJid: 'discord:owner-transfer',
      groupName: 'successor owner',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });
    const done = senderB('Done generation 1', { ...route, done: true });
    await flushMicrotasks();

    expect(calls).toEqual(['Stop generation 1']);

    first.resolve(true);
    await expect(stop).resolves.toBe(true);
    await expect(done).resolves.toBe(true);
    expect(calls).toEqual(['Stop generation 1', 'Done generation 1']);
  });

  it('routes a newer-generation terminal through a pending control chain', async () => {
    const stopDispatch = deferred<boolean>();
    const calls: string[] = [];
    const channelRuntime = {
      progressCardIdentity: vi.fn(
        (
          _jid: string,
          options?: {
            done?: boolean;
            generation?: number;
            actionAffordances?: Array<{ kind: string }>;
          },
        ) =>
          options?.actionAffordances?.some(
            (action) => action.kind === 'live_turn_stop',
          )
            ? 'discord-control'
            : `discord-generation-${options?.generation ?? ''}`,
      ),
      sendProgressUpdate: vi.fn(async (_jid: string, text: string) => {
        calls.push(text);
        return text === 'Stop generation 1' ? stopDispatch.promise : true;
      }),
    } as never;
    const sender = createProgressChannelSender({
      channelRuntime,
      chatJid: 'discord:cross-generation-pending',
      groupName: 'thread',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });

    const stop = sender('Stop generation 1', {
      generation: 1,
      actionAffordances: [
        {
          kind: 'live_turn_stop',
          label: 'Stop',
          actionToken: 'stop-token-1',
        },
      ],
    });
    const done = sender('Done generation 2', { generation: 2, done: true });
    await flushMicrotasks();

    expect(calls).toEqual(['Stop generation 1']);
    stopDispatch.resolve(true);
    await expect(stop).resolves.toBe(true);
    await expect(done).resolves.toBe(true);
    expect(calls).toEqual(['Stop generation 1', 'Done generation 2']);
  });

  it('keeps an older terminal off a newer pending control chain', async () => {
    const stopDispatch = deferred<boolean>();
    const calls: Array<{
      text: string;
      identity?: string;
      replaceOnly?: boolean;
    }> = [];
    const channelRuntime = {
      progressCardIdentity: vi.fn(
        (
          _jid: string,
          options?: {
            generation?: number;
            actionAffordances?: Array<{ kind: string }>;
          },
        ) =>
          options?.actionAffordances?.some(
            (action) => action.kind === 'live_turn_stop',
          )
            ? 'discord-control'
            : `discord-generation-${options?.generation ?? ''}`,
      ),
      sendProgressUpdate: vi.fn(
        async (
          _jid: string,
          text: string,
          options?: {
            progressCardIdentity?: string;
            replaceOnly?: boolean;
          },
        ) => {
          calls.push({
            text,
            identity: options?.progressCardIdentity,
            replaceOnly: options?.replaceOnly,
          });
          return text === 'Stop generation 2' ? stopDispatch.promise : false;
        },
      ),
    } as never;
    const sender = createProgressChannelSender({
      channelRuntime,
      chatJid: 'discord:older-terminal',
      groupName: 'thread',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });

    const stop = sender('Stop generation 2', {
      generation: 2,
      actionAffordances: [
        {
          kind: 'live_turn_stop',
          label: 'Stop',
          actionToken: 'stop-token-2',
        },
      ],
    });
    const done = sender('Done generation 1', { generation: 1, done: true });
    await flushMicrotasks();

    await expect(done).resolves.toBe(false);
    expect(calls[0]).toEqual({
      text: 'Stop generation 2',
      identity: 'discord-control',
      replaceOnly: undefined,
    });
    expect(calls.slice(1)).toHaveLength(2);
    expect(calls.slice(1)).toEqual(
      calls.slice(1).map(() => ({
        text: 'Done generation 1',
        identity: 'discord-generation-1',
        replaceOnly: true,
      })),
    );

    stopDispatch.resolve(true);
    await expect(stop).resolves.toBe(true);
  });

  it('freezes a queued terminal identity before a newer control is registered', async () => {
    const oldProgressDispatch = deferred<boolean>();
    const calls: Array<{ text: string; identity?: string }> = [];
    const channelRuntime = {
      progressCardIdentity: vi.fn(
        (
          _jid: string,
          options?: {
            generation?: number;
            actionAffordances?: Array<{ kind: string }>;
          },
        ) =>
          options?.actionAffordances?.some(
            (action) => action.kind === 'live_turn_stop',
          )
            ? 'discord-control'
            : `discord-generation-${options?.generation ?? ''}`,
      ),
      sendProgressUpdate: vi.fn(
        async (
          _jid: string,
          text: string,
          options?: { progressCardIdentity?: string },
        ) => {
          calls.push({ text, identity: options?.progressCardIdentity });
          return text === 'Generation 1 progress'
            ? oldProgressDispatch.promise
            : true;
        },
      ),
    } as never;
    const sender = createProgressChannelSender({
      channelRuntime,
      chatJid: 'discord:frozen-terminal',
      groupName: 'thread',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });

    const oldProgress = sender('Generation 1 progress', { generation: 1 });
    const oldDone = sender('Done generation 1', {
      generation: 1,
      done: true,
    });
    const newStop = sender('Stop generation 2', {
      generation: 2,
      actionAffordances: [
        {
          kind: 'live_turn_stop',
          label: 'Stop',
          actionToken: 'stop-token-2',
        },
      ],
    });
    await flushMicrotasks();
    expect(calls).toEqual([
      {
        text: 'Generation 1 progress',
        identity: 'discord-generation-1',
      },
      { text: 'Stop generation 2', identity: 'discord-control' },
    ]);

    await expect(newStop).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(oldDone).resolves.toBe(true);
    expect(calls.at(-1)).toEqual({
      text: 'Done generation 1',
      identity: 'discord-generation-1',
    });

    oldProgressDispatch.resolve(true);
    await expect(oldProgress).resolves.toBe(true);
  });

  it('preserves a queued newer stop identity across an older terminal', async () => {
    const stopOneDispatch = deferred<boolean>();
    const doneOneDispatch = deferred<boolean>();
    const stopTwoDispatch = deferred<boolean>();
    const calls: string[] = [];
    const channelRuntime = {
      progressCardIdentity: vi.fn(
        (
          _jid: string,
          options?: {
            generation?: number;
            actionAffordances?: Array<{ kind: string }>;
          },
        ) =>
          options?.actionAffordances?.some(
            (action) => action.kind === 'live_turn_stop',
          )
            ? 'discord-control'
            : `discord-generation-${options?.generation ?? ''}`,
      ),
      sendProgressUpdate: vi.fn(async (_jid: string, text: string) => {
        calls.push(text);
        if (text === 'Stop generation 1') return stopOneDispatch.promise;
        if (text === 'Done generation 1') return doneOneDispatch.promise;
        if (text === 'Stop generation 2') return stopTwoDispatch.promise;
        return true;
      }),
    } as never;
    const sender = createProgressChannelSender({
      channelRuntime,
      chatJid: 'discord:queued-newer-stop',
      groupName: 'thread',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });
    const stopAction = (generation: number) => [
      {
        kind: 'live_turn_stop' as const,
        label: 'Stop',
        actionToken: `stop-token-${generation}`,
      },
    ];

    const stopOne = sender('Stop generation 1', {
      generation: 1,
      actionAffordances: stopAction(1),
    });
    const doneOne = sender('Done generation 1', {
      generation: 1,
      done: true,
    });
    stopOneDispatch.resolve(true);
    await expect(stopOne).resolves.toBe(true);
    await flushMicrotasks();
    expect(calls).toEqual(['Stop generation 1', 'Done generation 1']);

    const stopTwo = sender('Stop generation 2', {
      generation: 2,
      actionAffordances: stopAction(2),
    });
    doneOneDispatch.resolve(true);
    await expect(doneOne).resolves.toBe(true);
    await flushMicrotasks();
    expect(calls).toEqual([
      'Stop generation 1',
      'Done generation 1',
      'Stop generation 2',
    ]);
    expect(progressCardIdentityCacheSize(channelRuntime)).toBe(1);

    const doneTwo = sender('Done generation 2', {
      generation: 2,
      done: true,
    });
    await flushMicrotasks();
    expect(calls).toHaveLength(3);

    stopTwoDispatch.resolve(true);
    await expect(stopTwo).resolves.toBe(true);
    await expect(doneTwo).resolves.toBe(true);
    expect(calls).toEqual([
      'Stop generation 1',
      'Done generation 1',
      'Stop generation 2',
      'Done generation 2',
    ]);
  });

  it('forces replace-only when reconciling an optionless update after owner timeout', async () => {
    const oldUpdate = deferred<boolean>();
    const calls: Array<{ text: string; replaceOnly?: boolean }> = [];
    const channelRuntime = {
      sendProgressUpdate: vi.fn(
        async (
          _jid: string,
          text: string,
          options?: { replaceOnly?: boolean },
        ) => {
          calls.push({ text, replaceOnly: options?.replaceOnly });
          if (text === 'Old optionless update') return oldUpdate.promise;
          return true;
        },
      ),
    } as never;
    const oldSender = createProgressChannelSender({
      channelRuntime,
      chatJid: 'discord:optionless-transfer',
      groupName: 'old turn',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });
    const stale = oldSender('Old optionless update');
    const newSender = createProgressChannelSender({
      channelRuntime,
      chatJid: 'discord:optionless-transfer',
      groupName: 'new turn',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });
    const current = newSender('Current optionless update');

    await vi.advanceTimersByTimeAsync(2_000);
    await expect(current).resolves.toBe(true);
    oldUpdate.resolve(true);
    await expect(stale).resolves.toBe(true);
    await flushMicrotasks();

    expect(calls).toEqual([
      { text: 'Old optionless update', replaceOnly: undefined },
      { text: 'Current optionless update', replaceOnly: true },
      { text: 'Current optionless update', replaceOnly: true },
    ]);
  });

  it('lets repair create a missing stop card after the original send returned false', async () => {
    const calls: Array<{ replaceOnly?: boolean }> = [];
    const channelRuntime = {
      progressCardIdentity: vi.fn(() => 'discord-control'),
      sendProgressUpdate: vi.fn(
        async (
          _jid: string,
          _text: string,
          options?: { replaceOnly?: boolean },
        ) => {
          calls.push({ replaceOnly: options?.replaceOnly });
          if (calls.length > 1) return true;
          return false;
        },
      ),
    } as never;
    const sender = createProgressChannelSender({
      channelRuntime,
      chatJid: 'discord:definitive-stop-false',
      groupName: 'thread',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });

    const send = sender('Stop', {
      generation: 1,
      actionAffordances: [
        {
          kind: 'live_turn_stop',
          label: 'Stop',
          actionToken: 'stop-token',
        },
      ],
    });

    await expect(send).resolves.toBe(false);
    await flushMicrotasks();

    expect(calls).toEqual([
      { replaceOnly: undefined },
      { replaceOnly: undefined },
    ]);
  });

  it('keeps repair replace-only after the original send rejects ambiguously', async () => {
    const calls: Array<{ replaceOnly?: boolean }> = [];
    const channelRuntime = {
      progressCardIdentity: vi.fn(() => 'discord-control'),
      sendProgressUpdate: vi.fn(
        async (
          _jid: string,
          _text: string,
          options?: { replaceOnly?: boolean },
        ) => {
          calls.push({ replaceOnly: options?.replaceOnly });
          if (calls.length === 1) throw new Error('response lost');
          return false;
        },
      ),
    } as never;
    const sender = createProgressChannelSender({
      channelRuntime,
      chatJid: 'discord:ambiguous-rejected-stop',
      groupName: 'thread',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });

    await expect(
      sender('Stop', {
        generation: 1,
        actionAffordances: [
          {
            kind: 'live_turn_stop',
            label: 'Stop',
            actionToken: 'stop-token',
          },
        ],
      }),
    ).rejects.toThrow('response lost');
    await flushMicrotasks();

    expect(calls).toEqual([{ replaceOnly: undefined }, { replaceOnly: true }]);
  });

  it('forces a successor original replace-only while an earlier chain attempt is unsettled', async () => {
    const firstStop = deferred<boolean>();
    const calls: Array<{ text: string; replaceOnly?: boolean }> = [];
    const channelRuntime = {
      progressCardIdentity: vi.fn(() => 'discord-control'),
      sendProgressUpdate: vi.fn(
        async (
          _jid: string,
          text: string,
          options?: { replaceOnly?: boolean },
        ) => {
          calls.push({ text, replaceOnly: options?.replaceOnly });
          if (text === 'Stop generation 1') return firstStop.promise;
          return false;
        },
      ),
    } as never;
    const sender = createProgressChannelSender({
      channelRuntime,
      chatJid: 'discord:ambiguous-successor-original',
      groupName: 'thread',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });
    const stopAction = (generation: number) => [
      {
        kind: 'live_turn_stop' as const,
        label: 'Stop',
        actionToken: `stop-token-${generation}`,
      },
    ];

    const first = sender('Stop generation 1', {
      generation: 1,
      actionAffordances: stopAction(1),
    });
    const successor = sender('Stop generation 2', {
      generation: 2,
      actionAffordances: stopAction(2),
    });

    await vi.advanceTimersByTimeAsync(2_000);
    await expect(successor).resolves.toBe(false);
    expect(calls[0]).toEqual({
      text: 'Stop generation 1',
      replaceOnly: undefined,
    });
    expect(calls.slice(1)).not.toHaveLength(0);
    expect(calls.slice(1)).toEqual(
      calls.slice(1).map(() => ({
        text: 'Stop generation 2',
        replaceOnly: true,
      })),
    );

    firstStop.resolve(true);
    await expect(first).resolves.toBe(true);
  });

  it('keeps repair replace-only while the original stop outcome is ambiguous', async () => {
    const stale = deferred<boolean>();
    const stop = deferred<boolean>();
    const calls: Array<{ text: string; replaceOnly?: boolean }> = [];
    const channelRuntime = {
      progressCardIdentity: vi.fn(() => 'discord-control'),
      sendProgressUpdate: vi.fn(
        async (
          _jid: string,
          text: string,
          options?: { replaceOnly?: boolean },
        ) => {
          calls.push({ text, replaceOnly: options?.replaceOnly });
          if (text === 'Old state') return stale.promise;
          if (calls.filter((call) => call.text === 'Stop').length === 1) {
            return stop.promise;
          }
          return true;
        },
      ),
    } as never;
    const sender = createProgressChannelSender({
      channelRuntime,
      chatJid: 'discord:ambiguous-stop',
      groupName: 'thread',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });

    const old = sender('Old state', { generation: 1 });
    const pendingStop = sender('Stop', {
      generation: 1,
      actionAffordances: [
        {
          kind: 'live_turn_stop',
          label: 'Stop',
          actionToken: 'stop-token',
        },
      ],
    });
    await vi.advanceTimersByTimeAsync(4_000);
    stale.resolve(true);
    await expect(old).resolves.toBe(true);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(2_000);

    expect(calls).toEqual([
      { text: 'Old state', replaceOnly: undefined },
      { text: 'Stop', replaceOnly: true },
      { text: 'Stop', replaceOnly: true },
    ]);

    stop.resolve(false);
    await expect(pendingStop).resolves.toBe(false);
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

  it('keeps a dispatched retry status repairable after its sender retires', async () => {
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
      chatJid: 'discord:retry-retirement',
      groupName: 'thread',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });
    const options = { threadId: 'thread', generation: 42 };

    const stale = sender('Still working', {
      ...options,
      replaceOnly: true,
    });
    const retrying = sender('retrying 1/3', {
      ...options,
      replaceOnly: true,
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(retrying).resolves.toBe(true);
    sender.retire();

    stalled.resolve(true);
    await expect(stale).resolves.toBe(true);
    await flushMicrotasks();

    expect(calls).toEqual(['Still working', 'retrying 1/3', 'retrying 1/3']);
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
    const stalled = deferred<boolean>();
    const calls: string[] = [];
    const finalizingGenerations = new Set<number>();
    const sender = createProgressChannelSender({
      channelRuntime: {
        sendProgressUpdate: vi.fn(async (_jid: string, text: string) => {
          calls.push(text);
          if (text === 'Still working') return stalled.promise;
          return true;
        }),
      } as never,
      chatJid: 'discord:finalizing-guard',
      groupName: 'thread',
      finalizingGenerations,
      log: { warn: vi.fn() },
    });
    const options = { threadId: 'thread', generation: 47 };

    const stale = sender('Still working', {
      ...options,
      replaceOnly: true,
    });
    const done = sender('Done.', { ...options, done: true });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(done).resolves.toBe(true);
    finalizingGenerations.add(options.generation);
    await expect(sender('Suppressed update.', options)).resolves.toBe(false);
    sender.retire();
    stalled.resolve(true);
    await expect(stale).resolves.toBe(true);
    await flushMicrotasks();

    expect(calls).toEqual(['Still working', 'Done.', 'Done.']);
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

  it('retries a rejected repair with bounded backoff and restores terminal state', async () => {
    const stalled = deferred<boolean>();
    const calls: string[] = [];
    let repairAttempts = 0;
    const channelRuntime = {
      sendProgressUpdate: vi.fn(async (_jid: string, text: string) => {
        calls.push(text);
        if (text === 'Still working') return stalled.promise;
        if (calls.length > 2 && repairAttempts++ === 0) {
          throw new Error('terminal repair rejected');
        }
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

  it('does not reissue an undispatched superseded stall repair after an older send settles late', async () => {
    const older = deferred<boolean>();
    const stalled = deferred<boolean>();
    const calls: string[] = [];
    const channelRuntime = {
      sendProgressUpdate: vi.fn(async (_jid: string, text: string) => {
        calls.push(text);
        if (text === 'Working') return older.promise;
        if (text === 'Still working') return stalled.promise;
        return true;
      }),
    } as never;
    const sender = createProgressChannelSender({
      channelRuntime,
      chatJid: 'discord:superseded-stall-repair',
      groupName: 'thread',
      finalizingGenerations: new Set<number>(),
      log: { warn: vi.fn() },
    });
    const options = { threadId: 'thread', generation: 66 };

    const first = sender('Working', options);
    const stall = sender('Still working', options);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toEqual(['Working', 'Still working']);

    older.resolve(true);
    await expect(first).resolves.toBe(true);
    await flushMicrotasks();

    const beforeVisible = sender.beforeVisibleDelivery(options);
    stalled.resolve(false);
    await expect(stall).resolves.toBe(false);
    await beforeVisible;
    await flushMicrotasks();

    expect(calls.filter((text) => text === 'Still working')).toHaveLength(1);
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
