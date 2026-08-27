import { describe, expect, it, vi } from 'vitest';

import {
  DiscordProgressIdentityLifecycle,
  sendDiscordProgressUpdateForRoute,
} from '@core/channels/discord/progress.js';
import { postDiscordMessageParts } from '@core/channels/discord/delivery.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('Discord progress lifecycle', () => {
  it('uses a retained handle only for terminal repairs', async () => {
    const activeMessages = new Map<string, string>();
    const identityLifecycle = new DiscordProgressIdentityLifecycle();
    identityLifecycle.retainMessageHandle(
      'dc:channel-1\n',
      'progress-1',
      'message-1',
    );
    const post = vi.fn(async () => ({ externalMessageId: 'unexpected' }));
    const edit = vi.fn(async () => undefined);
    const base = {
      routeKey: 'dc:channel-1\n',
      key: 'progress-1',
      activeMessages,
      identityLifecycle,
      post,
      edit,
    };

    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'Still working',
        options: { replaceOnly: true },
      }),
    ).resolves.toBe(false);
    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'Done.',
        options: { done: true, replaceOnly: true },
      }),
    ).resolves.toBe(true);

    expect(edit.mock.calls.map(([messageId]) => messageId)).toEqual([
      'message-1',
    ]);
    expect(post).not.toHaveBeenCalled();
  });

  it('treats a completed create without a message id as ambiguous', async () => {
    const activeMessages = new Map<string, string>();
    const identityLifecycle = new DiscordProgressIdentityLifecycle();
    const post = vi.fn(async () => ({ deliveredParts: 1, totalParts: 1 }));
    const edit = vi.fn(async () => undefined);
    const base = {
      routeKey: 'dc:channel-1\n',
      key: 'progress-1',
      activeMessages,
      identityLifecycle,
      post,
      edit,
    };

    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'Working',
        options: {},
      }),
    ).resolves.toBe(true);
    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'Done.',
        options: {
          done: true,
          progressCardIdentity: 'progress-1',
        },
      }),
    ).resolves.toBe(false);

    expect(post).toHaveBeenCalledTimes(1);
    expect(edit).not.toHaveBeenCalled();
  });

  it('settles rejected create attempts and expires a never-settling attempt', async () => {
    vi.useFakeTimers();
    const identityLifecycle = new DiscordProgressIdentityLifecycle();
    const pendingAttempts = () =>
      [
        ...(
          identityLifecycle as unknown as {
            stateByProgressKey: Map<
              string,
              { attempts: Map<number, { outcome?: string }> }
            >;
          }
        ).stateByProgressKey.values(),
      ].reduce(
        (count, state) =>
          count +
          [...state.attempts.values()].filter(
            (attempt) => attempt.outcome === undefined,
          ).length,
        0,
      );
    const activeMessages = new Map<string, string>();
    const edit = vi.fn(async () => undefined);

    for (let index = 0; index < 100; index += 1) {
      await expect(
        sendDiscordProgressUpdateForRoute({
          routeKey: `dc:channel-${index}\n`,
          key: `progress-${index}`,
          activeMessages,
          identityLifecycle,
          text: 'Working',
          options: {},
          post: async () => {
            throw new Error('discord down');
          },
          edit,
        }),
      ).rejects.toThrow('discord down');
    }
    expect(pendingAttempts()).toBe(0);

    const hung = sendDiscordProgressUpdateForRoute({
      routeKey: 'dc:hung\n',
      key: 'progress-hung',
      activeMessages,
      identityLifecycle,
      text: 'Working',
      options: {},
      post: async () => new Promise(() => undefined),
      edit,
    });
    const hungResult = expect(hung).rejects.toThrow(
      'Discord progress mutation did not settle after abort grace',
    );
    expect(pendingAttempts()).toBe(1);

    await vi.advanceTimersByTimeAsync(50_000);
    await hungResult;
    expect(identityLifecycle.mutationQueue.pendingByProgressKey.size).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * 60_000 - 50_000);
    expect(pendingAttempts()).toBe(0);
    vi.useRealTimers();
  });

  it('bounds active create-attempt state across routes', () => {
    const identityLifecycle = new DiscordProgressIdentityLifecycle();
    const state = identityLifecycle as unknown as {
      stateByProgressKey: Map<string, unknown>;
      createTombstoneByProgressKey: Map<string, unknown>;
    };

    for (let index = 0; index < 5_001; index += 1) {
      identityLifecycle.prepare({
        routeKey: `dc:channel-${index}\n`,
        progressKey: `progress-${index}`,
        text: 'Working',
        options: {},
        hasHandle: false,
      });
    }

    expect(state.stateByProgressKey.size).toBe(5_000);
    expect(state.createTombstoneByProgressKey.size).toBe(1);
  });

  it('keeps definitive missing after a blank create is skipped', async () => {
    const activeMessages = new Map<string, string>();
    const identityLifecycle = new DiscordProgressIdentityLifecycle();
    const post = vi
      .fn()
      .mockResolvedValueOnce({ deliveredParts: 0, totalParts: 1 })
      .mockResolvedValueOnce({ externalMessageId: 'message-terminal' });
    const edit = vi.fn(async () => undefined);
    const base = {
      routeKey: 'dc:channel-1\n',
      key: 'progress-1',
      activeMessages,
      identityLifecycle,
      post,
      edit,
    };

    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'Working',
        options: {},
      }),
    ).resolves.toBe(false);
    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: '',
        options: {
          done: true,
          progressCardIdentity: 'progress-1',
        },
      }),
    ).resolves.toBe(false);
    expect(post).toHaveBeenCalledTimes(1);

    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'I hit an issue.',
        options: {
          done: true,
          progressCardIdentity: 'progress-1',
        },
      }),
    ).resolves.toBe(true);
    expect(post).toHaveBeenCalledTimes(2);
    expect(activeMessages.has('progress-1')).toBe(false);
    expect(edit).not.toHaveBeenCalled();
  });

  it('clears definitive missing after an accepted terminal create without an id', async () => {
    const activeMessages = new Map<string, string>();
    const identityLifecycle = new DiscordProgressIdentityLifecycle();
    const post = vi
      .fn()
      .mockResolvedValueOnce({ deliveredParts: 0, totalParts: 1 })
      .mockResolvedValueOnce({ deliveredParts: 1, totalParts: 1 });
    const edit = vi.fn(async () => undefined);
    const base = {
      routeKey: 'dc:channel-1\n',
      key: 'progress-1',
      activeMessages,
      identityLifecycle,
      post,
      edit,
    };

    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'Working',
        options: {},
      }),
    ).resolves.toBe(false);
    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'I hit an issue.',
        options: {
          done: true,
          progressCardIdentity: 'progress-1',
        },
      }),
    ).resolves.toBe(true);
    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'I hit an issue.',
        options: {
          done: true,
          progressCardIdentity: 'progress-1',
        },
      }),
    ).resolves.toBe(false);

    expect(post).toHaveBeenCalledTimes(2);
    expect(edit).not.toHaveBeenCalled();
  });

  it('keeps a rejected terminal create ambiguous', async () => {
    const activeMessages = new Map<string, string>();
    const identityLifecycle = new DiscordProgressIdentityLifecycle();
    const post = vi
      .fn()
      .mockResolvedValueOnce({ deliveredParts: 0, totalParts: 1 })
      .mockRejectedValueOnce(new Error('discord down'));
    const edit = vi.fn(async () => undefined);
    const base = {
      routeKey: 'dc:channel-1\n',
      key: 'progress-1',
      activeMessages,
      identityLifecycle,
      post,
      edit,
    };

    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'Working',
        options: {},
      }),
    ).resolves.toBe(false);
    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'I hit an issue.',
        options: {
          done: true,
          progressCardIdentity: 'progress-1',
        },
      }),
    ).rejects.toThrow('discord down');
    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'I hit an issue.',
        options: {
          done: true,
          progressCardIdentity: 'progress-1',
        },
      }),
    ).resolves.toBe(false);

    expect(post).toHaveBeenCalledTimes(2);
    expect(edit).not.toHaveBeenCalled();
  });

  it('restores definitive missing only after a definitively empty create', async () => {
    const activeMessages = new Map<string, string>();
    const identityLifecycle = new DiscordProgressIdentityLifecycle();
    const post = vi
      .fn()
      .mockResolvedValueOnce({ deliveredParts: 0, totalParts: 1 })
      .mockResolvedValueOnce({ deliveredParts: 0, totalParts: 1 })
      .mockResolvedValueOnce({ externalMessageId: 'message-terminal' });
    const edit = vi.fn(async () => undefined);
    const base = {
      routeKey: 'dc:channel-1\n',
      key: 'progress-1',
      activeMessages,
      identityLifecycle,
      post,
      edit,
    };

    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'Working',
        options: {},
      }),
    ).resolves.toBe(false);
    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'I hit an issue.',
        options: {
          done: true,
          progressCardIdentity: 'progress-1',
        },
      }),
    ).resolves.toBe(false);
    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'I hit an issue.',
        options: {
          done: true,
          progressCardIdentity: 'progress-1',
        },
      }),
    ).resolves.toBe(true);

    expect(post).toHaveBeenCalledTimes(3);
    expect(edit).not.toHaveBeenCalled();
  });

  it('keeps a consumed missing marker ambiguous when the final chunk rejects', async () => {
    const activeMessages = new Map<string, string>();
    const identityLifecycle = new DiscordProgressIdentityLifecycle();
    const chunkPost = vi
      .fn()
      .mockResolvedValueOnce({ id: 'message-first-chunk' })
      .mockRejectedValueOnce(new Error('final chunk rejected'));
    const post = vi
      .fn()
      .mockResolvedValueOnce({ deliveredParts: 0, totalParts: 1 })
      .mockImplementationOnce(async (text: string) =>
        postDiscordMessageParts({
          channelId: 'channel-1',
          parts: [text.slice(0, 2_000), text.slice(2_000)],
          post: chunkPost,
        }),
      )
      .mockResolvedValueOnce({ externalMessageId: 'unexpected-duplicate' });
    const edit = vi.fn(async () => undefined);
    const base = {
      routeKey: 'dc:channel-1\n',
      key: 'progress-1',
      activeMessages,
      identityLifecycle,
      post,
      edit,
    };

    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'Working',
        options: {},
      }),
    ).resolves.toBe(false);
    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'x'.repeat(2_001),
        options: {
          done: true,
          progressCardIdentity: 'progress-1',
        },
      }),
    ).rejects.toThrow('Discord message partially delivered (1/2 parts)');
    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'I hit an issue.',
        options: {
          done: true,
          progressCardIdentity: 'progress-1',
        },
      }),
    ).resolves.toBe(false);

    expect(post).toHaveBeenCalledTimes(2);
    expect(chunkPost).toHaveBeenCalledTimes(2);
    expect(edit).not.toHaveBeenCalled();
  });

  it('preserves sticky ambiguity after settled attempts are cleared', async () => {
    const activeMessages = new Map<string, string>();
    const identityLifecycle = new DiscordProgressIdentityLifecycle();
    const post = vi
      .fn()
      .mockResolvedValueOnce({ deliveredParts: 1, totalParts: 1 })
      .mockResolvedValueOnce({ deliveredParts: 0, totalParts: 1 })
      .mockResolvedValueOnce({ externalMessageId: 'unexpected-duplicate' });
    const edit = vi.fn(async () => undefined);
    const base = {
      routeKey: 'dc:channel-1\n',
      key: 'progress-1',
      activeMessages,
      identityLifecycle,
      post,
      edit,
    };

    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'Working ambiguously',
        options: {},
      }),
    ).resolves.toBe(true);
    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'Working definitively empty',
        options: {},
      }),
    ).resolves.toBe(false);
    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'Done.',
        options: {
          done: true,
          progressCardIdentity: 'progress-1',
        },
      }),
    ).resolves.toBe(false);

    expect(post).toHaveBeenCalledTimes(2);
    expect(edit).not.toHaveBeenCalled();
  });

  it('releases an older held id when the newer create lands', async () => {
    const oldCreate = deferred<{ externalMessageId: string }>();
    const newCreate = deferred<{ externalMessageId: string }>();
    const activeMessages = new Map<string, string>();
    const identityLifecycle = new DiscordProgressIdentityLifecycle();
    const post = vi
      .fn()
      .mockImplementationOnce(async () => oldCreate.promise)
      .mockImplementationOnce(async () => newCreate.promise);
    const edit = vi.fn(async () => undefined);
    const base = {
      routeKey: 'dc:channel-1\n',
      key: 'progress-1',
      activeMessages,
      identityLifecycle,
      post,
      edit,
    };

    const oldTerminal = sendDiscordProgressUpdateForRoute({
      ...base,
      text: 'Done.',
      options: { done: true },
    });
    await Promise.resolve();
    const newer = sendDiscordProgressUpdateForRoute({
      ...base,
      text: 'Working again',
      options: {},
    });
    await Promise.resolve();

    oldCreate.resolve({ externalMessageId: 'message-old' });
    await oldTerminal;
    newCreate.resolve({ externalMessageId: 'message-new' });
    await expect(newer).resolves.toBe(true);
    expect(activeMessages.get('progress-1')).toBe('message-new');

    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'Still working',
        options: { replaceOnly: true },
      }),
    ).resolves.toBe(true);
    expect(edit.mock.calls.map(([messageId]) => messageId)).toEqual([
      'message-new',
    ]);
  });

  it('reconciles a definitively empty create after attempt retention expires', async () => {
    vi.useFakeTimers();
    const activeMessages = new Map<string, string>();
    const identityLifecycle = new DiscordProgressIdentityLifecycle();
    const post = vi.fn(async () => ({ externalMessageId: 'message-next' }));
    const edit = vi.fn(async () => undefined);
    const base = {
      routeKey: 'dc:channel-1\n',
      key: 'progress-1',
      activeMessages,
      identityLifecycle,
      post,
      edit,
    };

    const prepared = identityLifecycle.prepare({
      routeKey: base.routeKey,
      progressKey: base.key,
      text: 'Working',
      options: {},
      hasHandle: false,
    });
    expect(prepared.createAttempt).toBeDefined();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    identityLifecycle.reconcileCreateSettlement({
      createAttempt: prepared.createAttempt!,
      outcome: 'definitively_missing',
    });

    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'Done.',
        options: {
          done: true,
          progressCardIdentity: 'progress-1',
        },
      }),
    ).resolves.toBe(true);
    expect(post).toHaveBeenCalledTimes(1);
    expect(edit).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('activates a landed create after attempt retention expires', async () => {
    vi.useFakeTimers();
    const activeMessages = new Map<string, string>();
    const identityLifecycle = new DiscordProgressIdentityLifecycle();
    const post = vi.fn(async () => ({ externalMessageId: 'unexpected' }));
    const edit = vi.fn(async () => undefined);
    const base = {
      routeKey: 'dc:channel-1\n',
      key: 'progress-1',
      activeMessages,
      identityLifecycle,
      post,
      edit,
    };

    const prepared = identityLifecycle.prepare({
      routeKey: base.routeKey,
      progressKey: base.key,
      text: 'Working',
      options: {},
      hasHandle: false,
    });
    expect(prepared.createAttempt).toBeDefined();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const settlement = identityLifecycle.reconcileCreateSettlement({
      createAttempt: prepared.createAttempt!,
      outcome: 'landed',
      messageId: 'message-expired',
    });
    activeMessages.set('progress-1', settlement.handle!.messageId);

    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'Still working',
        options: { replaceOnly: true },
      }),
    ).resolves.toBe(true);
    expect(edit.mock.calls.map(([messageId]) => messageId)).toEqual([
      'message-expired',
    ]);
    expect(post).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('keeps definitive-missing markers isolated by route and progress key', async () => {
    const activeMessages = new Map<string, string>();
    const identityLifecycle = new DiscordProgressIdentityLifecycle();
    const post = vi
      .fn()
      .mockResolvedValueOnce({ deliveredParts: 0, totalParts: 1 })
      .mockResolvedValueOnce({ externalMessageId: 'message-b' })
      .mockResolvedValueOnce({ externalMessageId: 'message-a' });
    const edit = vi.fn(async () => undefined);
    const base = {
      routeKey: 'dc:channel-1\n',
      activeMessages,
      identityLifecycle,
      post,
      edit,
    };

    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        key: 'progress-a',
        text: 'Working A',
        options: {},
      }),
    ).resolves.toBe(false);
    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        key: 'progress-b',
        text: 'Working B',
        options: {},
      }),
    ).resolves.toBe(true);
    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        key: 'progress-a',
        text: 'Done A.',
        options: {
          done: true,
          progressCardIdentity: 'progress-a',
        },
      }),
    ).resolves.toBe(true);

    expect(post).toHaveBeenCalledTimes(3);
    expect(activeMessages.get('progress-b')).toBe('message-b');
  });

  it('does not let a held result for one key suppress another key landing', async () => {
    const oldA = deferred<{ externalMessageId: string }>();
    const newerA = deferred<{ deliveredParts: number; totalParts: number }>();
    const activeMessages = new Map<string, string>();
    const identityLifecycle = new DiscordProgressIdentityLifecycle();
    const post = vi
      .fn()
      .mockImplementationOnce(async () => oldA.promise)
      .mockImplementationOnce(async () => newerA.promise)
      .mockResolvedValueOnce({ externalMessageId: 'message-b' });
    const edit = vi.fn(async () => undefined);
    const base = {
      routeKey: 'dc:channel-1\n',
      activeMessages,
      identityLifecycle,
      post,
      edit,
    };

    const firstA = sendDiscordProgressUpdateForRoute({
      ...base,
      key: 'progress-a',
      text: 'Done A.',
      options: { done: true },
    });
    await Promise.resolve();
    const secondA = sendDiscordProgressUpdateForRoute({
      ...base,
      key: 'progress-a',
      text: 'Working A again',
      options: {},
    });
    await Promise.resolve();
    oldA.resolve({ externalMessageId: 'message-a-old' });
    await firstA;
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2));

    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        key: 'progress-b',
        text: 'Working B',
        options: {},
      }),
    ).resolves.toBe(true);
    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        key: 'progress-b',
        text: 'Still working B',
        options: { replaceOnly: true },
      }),
    ).resolves.toBe(true);

    expect(edit).toHaveBeenCalledWith(
      'message-b',
      expect.objectContaining({ content: 'Still working B' }),
      expect.any(AbortSignal),
    );
    newerA.resolve({ deliveredParts: 0, totalParts: 1 });
    await secondA;
  });

  it('reconciles empty and landed creates after route-cap eviction', async () => {
    const emptyCreate = deferred<{
      deliveredParts: number;
      totalParts: number;
    }>();
    const landedCreate = deferred<{ externalMessageId: string }>();
    const activeMessages = new Map<string, string>();
    const identityLifecycle = new DiscordProgressIdentityLifecycle();
    const emptyPost = vi
      .fn()
      .mockImplementationOnce(async () => emptyCreate.promise)
      .mockResolvedValueOnce({ externalMessageId: 'message-empty-retry' });
    const landedPost = vi.fn(async () => landedCreate.promise);
    const edit = vi.fn(async () => undefined);

    const empty = sendDiscordProgressUpdateForRoute({
      routeKey: 'dc:evicted-empty\n',
      key: 'progress-empty',
      activeMessages,
      identityLifecycle,
      text: 'Working empty',
      options: {},
      post: emptyPost,
      edit,
    });
    const landed = sendDiscordProgressUpdateForRoute({
      routeKey: 'dc:evicted-landed\n',
      key: 'progress-landed',
      activeMessages,
      identityLifecycle,
      text: 'Working landed',
      options: {},
      post: landedPost,
      edit,
    });
    await Promise.resolve();
    for (let index = 0; index < 5_000; index += 1) {
      identityLifecycle.prepare({
        routeKey: `dc:filler-${index}\n`,
        progressKey: `progress-filler-${index}`,
        text: 'Working',
        options: {},
        hasHandle: false,
      });
    }

    emptyCreate.resolve({ deliveredParts: 0, totalParts: 1 });
    landedCreate.resolve({ externalMessageId: 'message-evicted-landed' });
    await expect(empty).resolves.toBe(false);
    await expect(landed).resolves.toBe(true);

    await expect(
      sendDiscordProgressUpdateForRoute({
        routeKey: 'dc:evicted-empty\n',
        key: 'progress-empty',
        activeMessages,
        identityLifecycle,
        text: 'Done empty.',
        options: {
          done: true,
          progressCardIdentity: 'progress-empty',
        },
        post: emptyPost,
        edit,
      }),
    ).resolves.toBe(true);
    await expect(
      sendDiscordProgressUpdateForRoute({
        routeKey: 'dc:evicted-landed\n',
        key: 'progress-landed',
        activeMessages,
        identityLifecycle,
        text: 'Still working landed',
        options: { replaceOnly: true },
        post: landedPost,
        edit,
      }),
    ).resolves.toBe(true);

    expect(emptyPost).toHaveBeenCalledTimes(2);
    expect(edit).toHaveBeenCalledWith(
      'message-evicted-landed',
      expect.objectContaining({ content: 'Still working landed' }),
      expect.any(AbortSignal),
    );
  });

  it('terminalizes an edited handle when done overflow delivers zero parts', async () => {
    const activeMessages = new Map([['progress-1', 'message-1']]);
    const identityLifecycle = new DiscordProgressIdentityLifecycle();
    const post = vi.fn(async () => ({ deliveredParts: 0, totalParts: 1 }));
    const edit = vi.fn(async () => undefined);
    const base = {
      routeKey: 'dc:channel-1\n',
      key: 'progress-1',
      activeMessages,
      identityLifecycle,
      post,
      edit,
    };

    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'x'.repeat(2_001),
        options: { done: true },
      }),
    ).resolves.toBe(true);
    expect(activeMessages.has('progress-1')).toBe(false);

    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'Still working',
        options: { replaceOnly: true },
      }),
    ).resolves.toBe(false);
    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'Done.',
        options: { done: true, replaceOnly: true },
      }),
    ).resolves.toBe(true);
    expect(edit.mock.calls.at(-1)?.[0]).toBe('message-1');
  });

  it('enforces the state cap when restoring a pending tombstone', () => {
    const identityLifecycle = new DiscordProgressIdentityLifecycle();
    const state = identityLifecycle as unknown as {
      stateByProgressKey: Map<string, unknown>;
    };
    identityLifecycle.prepare({
      routeKey: 'dc:target\n',
      progressKey: 'progress-target',
      text: 'Working',
      options: {},
      hasHandle: false,
    });
    for (let index = 0; index < 5_000; index += 1) {
      identityLifecycle.prepare({
        routeKey: `dc:filler-${index}\n`,
        progressKey: `progress-filler-${index}`,
        text: 'Working',
        options: {},
        hasHandle: false,
      });
    }

    identityLifecycle.prepare({
      routeKey: 'dc:target\n',
      progressKey: 'progress-target',
      text: 'Working again',
      options: {},
      hasHandle: false,
    });

    expect(state.stateByProgressKey.size).toBe(5_000);
  });

  it('preserves definitive missing when state-cap churn evicts the key', async () => {
    const activeMessages = new Map<string, string>();
    const identityLifecycle = new DiscordProgressIdentityLifecycle();
    const post = vi
      .fn()
      .mockResolvedValueOnce({ deliveredParts: 0, totalParts: 1 })
      .mockResolvedValueOnce({ externalMessageId: 'message-terminal' });
    const base = {
      routeKey: 'dc:target\n',
      key: 'progress-target',
      activeMessages,
      identityLifecycle,
      post,
      edit: vi.fn(async () => undefined),
    };

    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'Working',
        options: {},
      }),
    ).resolves.toBe(false);
    for (let index = 0; index < 5_000; index += 1) {
      identityLifecycle.prepare({
        routeKey: `dc:filler-${index}\n`,
        progressKey: `progress-filler-${index}`,
        text: 'Working',
        options: {},
        hasHandle: false,
      });
    }

    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'Done.',
        options: {
          done: true,
          progressCardIdentity: 'progress-target',
        },
      }),
    ).resolves.toBe(true);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1]?.[0]).toBe('Done.');
  });

  it('keeps the edited base active when an overflow post rejects', async () => {
    const activeMessages = new Map([['progress-1', 'message-base']]);
    const identityLifecycle = new DiscordProgressIdentityLifecycle();
    const post = vi.fn(async () => {
      throw new Error('response lost');
    });
    const edit = vi.fn(async () => undefined);

    await expect(
      sendDiscordProgressUpdateForRoute({
        routeKey: 'dc:channel-1\n',
        key: 'progress-1',
        activeMessages,
        identityLifecycle,
        text: 'x'.repeat(2_001),
        options: {},
        post,
        edit,
      }),
    ).rejects.toThrow('response lost');

    expect(activeMessages.get('progress-1')).toBe('message-base');
  });

  it('tracks the overflow card after a nonterminal multipart update', async () => {
    const activeMessages = new Map([['progress-1', 'message-base']]);
    const identityLifecycle = new DiscordProgressIdentityLifecycle();
    const post = vi.fn(async () => ({
      externalMessageId: 'message-overflow',
    }));
    const edit = vi.fn(async () => undefined);
    const base = {
      routeKey: 'dc:channel-1\n',
      key: 'progress-1',
      activeMessages,
      identityLifecycle,
      post,
      edit,
    };

    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'x'.repeat(2_001),
        options: {},
      }),
    ).resolves.toBe(true);
    expect(activeMessages.get('progress-1')).toBe('message-overflow');

    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'Still working',
        options: { replaceOnly: true },
      }),
    ).resolves.toBe(true);
    expect(edit.mock.calls.at(-1)?.[0]).toBe('message-overflow');
  });

  it('retains the edited base after a terminal overflow lands', async () => {
    const activeMessages = new Map([['progress-1', 'message-base']]);
    const identityLifecycle = new DiscordProgressIdentityLifecycle();
    const post = vi.fn(async () => ({
      externalMessageId: 'message-overflow',
    }));
    const edit = vi.fn(async () => undefined);
    const base = {
      routeKey: 'dc:channel-1\n',
      key: 'progress-1',
      activeMessages,
      identityLifecycle,
      post,
      edit,
    };

    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'x'.repeat(2_001),
        options: { done: true },
      }),
    ).resolves.toBe(true);
    expect(activeMessages.has('progress-1')).toBe(false);

    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'Done.',
        options: { done: true, replaceOnly: true },
      }),
    ).resolves.toBe(true);
    expect(edit.mock.calls.slice(-2).map(([messageId]) => messageId)).toEqual([
      'message-base',
      'message-overflow',
    ]);
    expect(edit.mock.calls.at(-2)?.[1]).toMatchObject({ content: 'Done.' });
    expect(edit.mock.calls.at(-1)?.[1]).toMatchObject({ content: ' ' });
  });

  it('repairs a multipart terminal create in place without reposting overflow', async () => {
    const text = 'x'.repeat(4_500);
    const activeMessages = new Map<string, string>();
    const identityLifecycle = new DiscordProgressIdentityLifecycle();
    const post = vi.fn(async () => ({
      externalMessageId: 'message-1',
      externalMessageIds: ['message-1', 'message-2', 'message-3'],
      deliveredParts: 3,
      totalParts: 3,
    }));
    const edit = vi.fn(async () => undefined);
    const base = {
      routeKey: 'dc:channel-1\n',
      key: 'progress-1',
      activeMessages,
      identityLifecycle,
      text,
      post,
      edit,
    };

    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        options: { done: true },
      }),
    ).resolves.toBe(true);
    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        options: { done: true, replaceOnly: true },
      }),
    ).resolves.toBe(true);
    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        options: { done: true, replaceOnly: true },
      }),
    ).resolves.toBe(true);

    expect(post).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledTimes(2);
    expect(edit.mock.calls.map(([messageId]) => messageId)).toEqual([
      'message-1',
      'message-1',
    ]);
    expect(edit.mock.calls.map(([, body]) => body)).toEqual([
      {
        content: 'x'.repeat(2_000),
        allowed_mentions: { parse: [] },
        components: [],
      },
      {
        content: 'x'.repeat(2_000),
        allowed_mentions: { parse: [] },
        components: [],
      },
    ]);
  });

  it('rerenders every retained part when a terminal repair payload changes', async () => {
    const initialText = 'a'.repeat(2_500);
    const longerText = 'b'.repeat(4_500);
    const shorterText = 'c'.repeat(500);
    const activeMessages = new Map<string, string>();
    const identityLifecycle = new DiscordProgressIdentityLifecycle();
    const post = vi
      .fn()
      .mockResolvedValueOnce({
        externalMessageId: 'message-1',
        externalMessageIds: ['message-1', 'message-2'],
        deliveredParts: 2,
        totalParts: 2,
      })
      .mockResolvedValueOnce({
        externalMessageId: 'message-3',
        externalMessageIds: ['message-3'],
        deliveredParts: 1,
        totalParts: 1,
      });
    const edit = vi.fn(async () => undefined);
    const base = {
      routeKey: 'dc:channel-1\n',
      key: 'progress-1',
      activeMessages,
      identityLifecycle,
      post,
      edit,
    };

    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: initialText,
        options: { done: true },
      }),
    ).resolves.toBe(true);
    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: longerText,
        options: { done: true, replaceOnly: true },
      }),
    ).resolves.toBe(true);
    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: shorterText,
        options: { done: true, replaceOnly: true },
      }),
    ).resolves.toBe(true);
    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: shorterText,
        options: { done: true, replaceOnly: true },
      }),
    ).resolves.toBe(true);

    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1]?.[0]).toBe('b'.repeat(500));
    expect(
      edit.mock.calls.map(([messageId, body]) => [messageId, body]),
    ).toEqual([
      [
        'message-1',
        {
          content: 'b'.repeat(2_000),
          allowed_mentions: { parse: [] },
          components: [],
        },
      ],
      [
        'message-2',
        {
          content: 'b'.repeat(2_000),
          allowed_mentions: { parse: [] },
          components: [],
        },
      ],
      [
        'message-1',
        {
          content: 'c'.repeat(500),
          allowed_mentions: { parse: [] },
          components: [],
        },
      ],
      [
        'message-2',
        {
          content: ' ',
          allowed_mentions: { parse: [] },
          components: [],
        },
      ],
      [
        'message-3',
        {
          content: ' ',
          allowed_mentions: { parse: [] },
          components: [],
        },
      ],
      [
        'message-1',
        {
          content: 'c'.repeat(500),
          allowed_mentions: { parse: [] },
          components: [],
        },
      ],
    ]);
  });

  it('keeps a retained handle terminal when repair overflow rejects', async () => {
    const activeMessages = new Map<string, string>();
    const identityLifecycle = new DiscordProgressIdentityLifecycle();
    identityLifecycle.retainMessageHandle(
      'dc:channel-1\n',
      'progress-1',
      'message-terminal',
    );
    const post = vi.fn(async () => {
      throw new Error('response lost');
    });
    const edit = vi.fn(async () => undefined);
    const base = {
      routeKey: 'dc:channel-1\n',
      key: 'progress-1',
      activeMessages,
      identityLifecycle,
      post,
      edit,
    };

    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'x'.repeat(2_001),
        options: { done: true, replaceOnly: true },
      }),
    ).rejects.toThrow('response lost');

    expect(activeMessages.has('progress-1')).toBe(false);
    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'Still working',
        options: { replaceOnly: true },
      }),
    ).resolves.toBe(false);
    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'Done.',
        options: { done: true, replaceOnly: true },
      }),
    ).resolves.toBe(true);
    expect(edit.mock.calls.at(-1)?.[0]).toBe('message-terminal');
  });

  it('keeps definitive missing after settled state retention expires', async () => {
    vi.useFakeTimers();
    const activeMessages = new Map<string, string>();
    const identityLifecycle = new DiscordProgressIdentityLifecycle();
    const post = vi
      .fn()
      .mockResolvedValueOnce({ deliveredParts: 0 })
      .mockResolvedValueOnce({ externalMessageId: 'message-terminal' });
    const edit = vi.fn(async () => undefined);
    const base = {
      routeKey: 'dc:channel-1\n',
      key: 'progress-1',
      activeMessages,
      identityLifecycle,
      post,
      edit,
    };

    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'Working',
        options: {},
      }),
    ).resolves.toBe(false);

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'Done.',
        options: {
          done: true,
          progressCardIdentity: 'progress-1',
        },
      }),
    ).resolves.toBe(true);
    expect(post).toHaveBeenCalledTimes(2);
    expect(activeMessages.has('progress-1')).toBe(false);
    vi.useRealTimers();
  });

  it('releases a retained terminal handle after tombstone restoration', async () => {
    vi.useFakeTimers();
    const identityLifecycle = new DiscordProgressIdentityLifecycle();
    identityLifecycle.retainMessageHandle(
      'dc:channel-1\n',
      'progress-1',
      'message-terminal',
    );
    const prepared = identityLifecycle.prepare({
      routeKey: 'dc:channel-1\n',
      progressKey: 'progress-1',
      text: 'x'.repeat(2_001),
      options: { done: true, replaceOnly: true },
      hasHandle: false,
    });
    expect(prepared.createAttempt).toBeDefined();
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    prepared.createAttempt!.baseMessageId = 'message-terminal';
    prepared.createAttempt!.terminalBaseCompleted = true;
    identityLifecycle.reconcileCreateSettlement({
      createAttempt: prepared.createAttempt!,
      outcome: 'landed',
      messageId: 'message-overflow',
    });
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(
      identityLifecycle.retainedMessageId('dc:channel-1\n', 'progress-1'),
    ).toBeUndefined();
    vi.useRealTimers();
  });

  it('never sends an empty edit for repeated blank terminal updates', async () => {
    const activeMessages = new Map<string, string>();
    const identityLifecycle = new DiscordProgressIdentityLifecycle();
    identityLifecycle.retainMessageHandle(
      'dc:channel-1\n',
      'progress-1',
      'message-terminal',
    );
    const post = vi.fn(async () => ({ externalMessageId: 'unexpected' }));
    const edit = vi.fn(async () => undefined);
    const base = {
      routeKey: 'dc:channel-1\n',
      key: 'progress-1',
      activeMessages,
      identityLifecycle,
      post,
      edit,
    };

    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: '',
        options: { done: true, replaceOnly: true },
      }),
    ).resolves.toBe(false);
    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: '   ',
        options: { done: true, replaceOnly: true },
      }),
    ).resolves.toBe(false);

    expect(edit).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it('terminalizes an active card with the done fallback for a blank terminal', async () => {
    const activeMessages = new Map([['progress-1', 'message-active']]);
    const identityLifecycle = new DiscordProgressIdentityLifecycle();
    const post = vi.fn(async () => ({ externalMessageId: 'unexpected' }));
    const edit = vi.fn(async () => undefined);

    await expect(
      sendDiscordProgressUpdateForRoute({
        routeKey: 'dc:channel-1\n',
        key: 'progress-1',
        activeMessages,
        identityLifecycle,
        text: '',
        options: { done: true },
        post,
        edit,
      }),
    ).resolves.toBe(true);

    expect(edit).toHaveBeenCalledWith(
      'message-active',
      {
        content: 'Done.',
        allowed_mentions: { parse: [] },
        components: [],
      },
      expect.any(AbortSignal),
    );
    expect(post).not.toHaveBeenCalled();
    expect(activeMessages.has('progress-1')).toBe(false);
  });

  it('keeps multipart terminal repairs exclusive in the mutation queue', async () => {
    const firstEdit = deferred<void>();
    const activeMessages = new Map<string, string>();
    const identityLifecycle = new DiscordProgressIdentityLifecycle();
    const post = vi
      .fn()
      .mockResolvedValueOnce({
        externalMessageId: 'message-1',
        externalMessageIds: ['message-1', 'message-2'],
        deliveredParts: 2,
        totalParts: 2,
      })
      .mockResolvedValueOnce({
        externalMessageId: 'message-3',
        externalMessageIds: ['message-3'],
        deliveredParts: 1,
        totalParts: 1,
      });
    const edit = vi
      .fn<(messageId: string, body: Record<string, unknown>) => Promise<void>>()
      .mockImplementationOnce(async () => firstEdit.promise)
      .mockResolvedValue(undefined);
    const base = {
      routeKey: 'dc:channel-1\n',
      key: 'progress-1',
      activeMessages,
      identityLifecycle,
      post,
      edit,
    };

    await sendDiscordProgressUpdateForRoute({
      ...base,
      text: 'a'.repeat(2_500),
      options: { done: true },
    });
    const firstRepair = sendDiscordProgressUpdateForRoute({
      ...base,
      text: 'b'.repeat(4_500),
      options: { done: true, replaceOnly: true },
    });
    await Promise.resolve();
    const secondRepair = sendDiscordProgressUpdateForRoute({
      ...base,
      text: 'c'.repeat(500),
      options: { done: true, replaceOnly: true },
    });
    await Promise.resolve();

    expect(edit).toHaveBeenCalledTimes(1);
    expect(identityLifecycle.mutationQueue.pendingByProgressKey.size).toBe(1);
    firstEdit.resolve();
    await expect(firstRepair).resolves.toBe(true);
    await expect(secondRepair).resolves.toBe(true);
    expect(identityLifecycle.mutationQueue.pendingByProgressKey.size).toBe(0);

    expect(edit.mock.calls.map(([messageId]) => messageId)).toEqual([
      'message-1',
      'message-2',
      'message-1',
      'message-2',
      'message-3',
    ]);
    expect(edit.mock.calls.at(-3)?.[1]).toMatchObject({
      content: 'c'.repeat(500),
    });
  });

  it('does not repost an identical terminal overflow after an ambiguous rejection', async () => {
    const activeMessages = new Map<string, string>();
    const identityLifecycle = new DiscordProgressIdentityLifecycle();
    const post = vi
      .fn()
      .mockResolvedValueOnce({
        externalMessageId: 'message-1',
        externalMessageIds: ['message-1', 'message-2'],
        deliveredParts: 2,
        totalParts: 2,
      })
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce({ externalMessageId: 'duplicate-overflow' });
    const edit = vi.fn(async () => undefined);
    const base = {
      routeKey: 'dc:channel-1\n',
      key: 'progress-1',
      activeMessages,
      identityLifecycle,
      post,
      edit,
    };

    await sendDiscordProgressUpdateForRoute({
      ...base,
      text: 'a'.repeat(2_500),
      options: { done: true },
    });
    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'b'.repeat(4_500),
        options: { done: true, replaceOnly: true },
      }),
    ).rejects.toThrow('response lost');
    const editsBeforeRetry = edit.mock.calls.length;

    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'b'.repeat(4_500),
        options: { done: true, replaceOnly: true },
      }),
    ).resolves.toBe(true);

    expect(post).toHaveBeenCalledTimes(2);
    expect(edit).toHaveBeenCalledTimes(editsBeforeRetry + 1);
    expect(edit.mock.calls.at(-1)?.[0]).toBe('message-1');
  });

  it('keeps every known terminal part id after a repair fails partway', async () => {
    const activeMessages = new Map<string, string>();
    const identityLifecycle = new DiscordProgressIdentityLifecycle();
    const post = vi.fn(async () => ({
      externalMessageId: 'message-1',
      externalMessageIds: ['message-1', 'message-2'],
      deliveredParts: 2,
      totalParts: 2,
    }));
    const edit = vi
      .fn<(messageId: string, body: Record<string, unknown>) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('second edit failed'))
      .mockResolvedValue(undefined);
    const base = {
      routeKey: 'dc:channel-1\n',
      key: 'progress-1',
      activeMessages,
      identityLifecycle,
      post,
      edit,
    };

    await sendDiscordProgressUpdateForRoute({
      ...base,
      text: 'a'.repeat(2_500),
      options: { done: true },
    });
    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'short',
        options: { done: true, replaceOnly: true },
      }),
    ).rejects.toThrow('second edit failed');
    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'short',
        options: { done: true, replaceOnly: true },
      }),
    ).resolves.toBe(true);

    expect(edit.mock.calls.map(([messageId]) => messageId)).toEqual([
      'message-1',
      'message-2',
      'message-1',
      'message-2',
    ]);
  });

  it('retains the complete multipart render when terminalizing an active card', async () => {
    const text = 'x'.repeat(2_500);
    const activeMessages = new Map([['progress-1', 'message-base']]);
    const identityLifecycle = new DiscordProgressIdentityLifecycle();
    const post = vi.fn(async () => ({
      externalMessageId: 'message-overflow',
      externalMessageIds: ['message-overflow'],
      deliveredParts: 1,
      totalParts: 1,
    }));
    const edit = vi.fn(async () => undefined);
    const base = {
      routeKey: 'dc:channel-1\n',
      key: 'progress-1',
      activeMessages,
      identityLifecycle,
      text,
      post,
      edit,
    };

    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        options: { done: true },
      }),
    ).resolves.toBe(true);
    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        options: { done: true, replaceOnly: true },
      }),
    ).resolves.toBe(true);

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      'x'.repeat(500),
      [],
      expect.any(AbortSignal),
    );
    expect(edit.mock.calls.map(([messageId]) => messageId)).toEqual([
      'message-base',
      'message-base',
    ]);
  });

  it('invalidates an ambiguous overflow fingerprint when another payload renders', async () => {
    const activeMessages = new Map<string, string>();
    const identityLifecycle = new DiscordProgressIdentityLifecycle();
    const post = vi
      .fn()
      .mockResolvedValueOnce({
        externalMessageId: 'message-1',
        externalMessageIds: ['message-1', 'message-2'],
        deliveredParts: 2,
        totalParts: 2,
      })
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce({
        externalMessageId: 'message-3',
        externalMessageIds: ['message-3'],
        deliveredParts: 1,
        totalParts: 1,
      });
    const edit = vi.fn(async () => undefined);
    const base = {
      routeKey: 'dc:channel-1\n',
      key: 'progress-1',
      activeMessages,
      identityLifecycle,
      post,
      edit,
    };

    await sendDiscordProgressUpdateForRoute({
      ...base,
      text: 'initial'.repeat(400),
      options: { done: true },
    });
    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'a'.repeat(4_500),
        options: { done: true, replaceOnly: true },
      }),
    ).rejects.toThrow('response lost');
    await sendDiscordProgressUpdateForRoute({
      ...base,
      text: 'b'.repeat(500),
      options: { done: true, replaceOnly: true },
    });
    const editsBeforeRetry = edit.mock.calls.length;

    await sendDiscordProgressUpdateForRoute({
      ...base,
      text: 'a'.repeat(4_500),
      options: { done: true, replaceOnly: true },
    });

    expect(post).toHaveBeenCalledTimes(3);
    expect(edit.mock.calls.slice(editsBeforeRetry).map(([id]) => id)).toEqual([
      'message-1',
      'message-2',
    ]);
    expect(post.mock.calls.at(-1)?.[0]).toBe('a'.repeat(500));
  });

  it('keeps an ambiguous overflow fingerprint when a different payload edit rejects', async () => {
    const activeMessages = new Map<string, string>();
    const identityLifecycle = new DiscordProgressIdentityLifecycle();
    const post = vi
      .fn()
      .mockResolvedValueOnce({
        externalMessageId: 'message-1',
        externalMessageIds: ['message-1', 'message-2'],
        deliveredParts: 2,
        totalParts: 2,
      })
      .mockRejectedValueOnce(new Error('overflow response lost'));
    const edit = vi
      .fn<(messageId: string, body: Record<string, unknown>) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('different render rejected'))
      .mockResolvedValue(undefined);
    const base = {
      routeKey: 'dc:channel-1\n',
      key: 'progress-1',
      activeMessages,
      identityLifecycle,
      post,
      edit,
    };

    await sendDiscordProgressUpdateForRoute({
      ...base,
      text: 'initial'.repeat(400),
      options: { done: true },
    });
    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'a'.repeat(4_500),
        options: { done: true, replaceOnly: true },
      }),
    ).rejects.toThrow('overflow response lost');
    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'b'.repeat(500),
        options: { done: true, replaceOnly: true },
      }),
    ).rejects.toThrow('different render rejected');
    const editsBeforeRetry = edit.mock.calls.length;

    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'a'.repeat(4_500),
        options: { done: true, replaceOnly: true },
      }),
    ).resolves.toBe(true);

    expect(post).toHaveBeenCalledTimes(2);
    expect(edit.mock.calls.slice(editsBeforeRetry).map(([id]) => id)).toEqual([
      'message-1',
    ]);
  });

  it('retains partial terminal ids without trusting the render fingerprint', async () => {
    const activeMessages = new Map<string, string>();
    const identityLifecycle = new DiscordProgressIdentityLifecycle();
    const post = vi
      .fn()
      .mockResolvedValueOnce({
        externalMessageId: 'message-1',
        externalMessageIds: ['message-1', 'message-2'],
        deliveredParts: 3,
        totalParts: 3,
      })
      .mockResolvedValueOnce({
        externalMessageId: 'message-3',
        externalMessageIds: ['message-3'],
        deliveredParts: 1,
        totalParts: 1,
      });
    const edit = vi.fn(async () => undefined);
    const base = {
      routeKey: 'dc:channel-1\n',
      key: 'progress-1',
      activeMessages,
      identityLifecycle,
      post,
      edit,
    };
    const text = 'x'.repeat(4_500);

    await sendDiscordProgressUpdateForRoute({
      ...base,
      text,
      options: { done: true },
    });
    await sendDiscordProgressUpdateForRoute({
      ...base,
      text,
      options: { done: true, replaceOnly: true },
    });

    expect(edit.mock.calls.map(([messageId]) => messageId)).toEqual([
      'message-1',
      'message-2',
    ]);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[1]?.[0]).toBe('x'.repeat(500));
  });

  it('keeps one provider mutation in flight and coalesces rapid updates to the newest payload', async () => {
    const firstEdit = deferred<void>();
    const activeMessages = new Map([['progress-1', 'message-base']]);
    const identityLifecycle = new DiscordProgressIdentityLifecycle();
    const rendered: string[] = [];
    let providerCallsInFlight = 0;
    let maxProviderCallsInFlight = 0;
    const edit = vi
      .fn<(messageId: string, body: Record<string, unknown>) => Promise<void>>()
      .mockImplementationOnce(async (_messageId, body) => {
        providerCallsInFlight += 1;
        maxProviderCallsInFlight = Math.max(
          maxProviderCallsInFlight,
          providerCallsInFlight,
        );
        await firstEdit.promise;
        rendered.push(String(body.content));
        providerCallsInFlight -= 1;
      })
      .mockImplementation(async (_messageId, body) => {
        providerCallsInFlight += 1;
        maxProviderCallsInFlight = Math.max(
          maxProviderCallsInFlight,
          providerCallsInFlight,
        );
        rendered.push(String(body.content));
        providerCallsInFlight -= 1;
      });
    const base = {
      routeKey: 'dc:channel-1\n',
      key: 'progress-1',
      activeMessages,
      identityLifecycle,
      options: {},
      post: vi.fn(async () => ({ externalMessageId: 'unexpected' })),
      edit,
    };

    const first = sendDiscordProgressUpdateForRoute({
      ...base,
      text: 'first',
    });
    await Promise.resolve();
    const queued = Array.from({ length: 5 }, (_, index) =>
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: `queued-${index + 1}`,
      }),
    );

    await expect(Promise.all(queued.slice(0, -1))).resolves.toEqual([
      true,
      true,
      true,
      true,
    ]);
    let newestSettled = false;
    void queued.at(-1)?.then(
      () => {
        newestSettled = true;
      },
      () => {
        newestSettled = true;
      },
    );
    await Promise.resolve();
    expect(newestSettled).toBe(false);
    expect(edit).toHaveBeenCalledTimes(1);
    expect(maxProviderCallsInFlight).toBe(1);

    firstEdit.resolve();
    await expect(first).resolves.toBe(true);
    await expect(queued.at(-1)).resolves.toBe(true);
    await vi.waitFor(() => expect(edit).toHaveBeenCalledTimes(2));

    expect(rendered).toEqual(['first', 'queued-5']);
    expect(maxProviderCallsInFlight).toBe(1);
    expect(identityLifecycle.mutationQueue.pendingByProgressKey.size).toBe(0);
  });

  it('returns the coalesced newest terminal mutation rejection to its caller', async () => {
    const firstEdit = deferred<void>();
    const activeMessages = new Map([['progress-1', 'message-base']]);
    const identityLifecycle = new DiscordProgressIdentityLifecycle();
    const edit = vi
      .fn<(messageId: string, body: Record<string, unknown>) => Promise<void>>()
      .mockImplementationOnce(async () => firstEdit.promise)
      .mockRejectedValueOnce(new Error('terminal edit rejected'));
    const base = {
      routeKey: 'dc:channel-1\n',
      key: 'progress-1',
      activeMessages,
      identityLifecycle,
      post: vi.fn(async () => ({ externalMessageId: 'unexpected' })),
      edit,
    };

    const first = sendDiscordProgressUpdateForRoute({
      ...base,
      text: 'Working',
      options: {},
    });
    await Promise.resolve();
    const superseded = sendDiscordProgressUpdateForRoute({
      ...base,
      text: 'Almost done',
      options: {},
    });
    const terminal = sendDiscordProgressUpdateForRoute({
      ...base,
      text: 'Done.',
      options: { done: true, replaceOnly: true },
    });
    const terminalResult = expect(terminal).rejects.toThrow(
      'terminal edit rejected',
    );

    await expect(superseded).resolves.toBe(true);
    firstEdit.resolve();
    await expect(first).resolves.toBe(true);
    await terminalResult;
    expect(edit).toHaveBeenCalledTimes(2);
    expect(identityLifecycle.mutationQueue.pendingByProgressKey.size).toBe(0);
  });

  it('aborts a hung provider mutation and renders the coalesced newest payload', async () => {
    vi.useFakeTimers();
    const activeMessages = new Map([['progress-1', 'message-base']]);
    const identityLifecycle = new DiscordProgressIdentityLifecycle();
    const rendered: string[] = [];
    let providerCallsInFlight = 0;
    let maxProviderCallsInFlight = 0;
    const edit = vi
      .fn<
        (
          messageId: string,
          body: Record<string, unknown>,
          signal?: AbortSignal,
        ) => Promise<void>
      >()
      .mockImplementationOnce(async (_messageId, _body, signal) => {
        providerCallsInFlight += 1;
        maxProviderCallsInFlight = Math.max(
          maxProviderCallsInFlight,
          providerCallsInFlight,
        );
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              providerCallsInFlight -= 1;
              reject(signal.reason);
            },
            { once: true },
          );
        });
      })
      .mockImplementation(async (_messageId, body) => {
        providerCallsInFlight += 1;
        maxProviderCallsInFlight = Math.max(
          maxProviderCallsInFlight,
          providerCallsInFlight,
        );
        rendered.push(String(body.content));
        providerCallsInFlight -= 1;
      });
    const base = {
      routeKey: 'dc:channel-1\n',
      key: 'progress-1',
      activeMessages,
      identityLifecycle,
      options: {},
      post: vi.fn(async () => ({ externalMessageId: 'unexpected' })),
      edit,
    };

    const hung = sendDiscordProgressUpdateForRoute({
      ...base,
      text: 'hung',
    });
    const hungResult = expect(hung).rejects.toThrow(
      'Discord progress mutation timed out',
    );
    await Promise.resolve();
    const queued = Array.from({ length: 5 }, (_, index) =>
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: `queued-${index + 1}`,
      }),
    );

    await expect(Promise.all(queued.slice(0, -1))).resolves.toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(edit).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(45_000);
    await hungResult;
    await expect(queued.at(-1)).resolves.toBe(true);
    await vi.runAllTicks();

    expect(edit).toHaveBeenCalledTimes(2);
    expect(rendered).toEqual(['queued-5']);
    expect(maxProviderCallsInFlight).toBe(1);
    expect(identityLifecycle.mutationQueue.pendingByProgressKey.size).toBe(0);
    vi.useRealTimers();
  });

  it('passes the abort deadline through progress posts', async () => {
    vi.useFakeTimers();
    const activeMessages = new Map<string, string>();
    const identityLifecycle = new DiscordProgressIdentityLifecycle();
    let receivedSignal: AbortSignal | undefined;
    const post = vi.fn(
      async (_text: string, _components?: unknown[], signal?: AbortSignal) => {
        receivedSignal = signal;
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        });
        return { externalMessageId: 'unreachable' };
      },
    );
    const create = sendDiscordProgressUpdateForRoute({
      routeKey: 'dc:channel-1\n',
      key: 'progress-1',
      activeMessages,
      identityLifecycle,
      text: 'Working',
      options: {},
      post,
      edit: vi.fn(async () => undefined),
    });
    const result = expect(create).rejects.toThrow(
      'Discord progress mutation timed out',
    );

    await Promise.resolve();
    expect(receivedSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(45_000);
    await result;

    expect(receivedSignal?.aborted).toBe(true);
    expect(identityLifecycle.mutationQueue.pendingByProgressKey.size).toBe(0);
    vi.useRealTimers();
  });

  it('advances after the abort grace when a provider ignores its signal', async () => {
    vi.useFakeTimers();
    const activeMessages = new Map([['progress-1', 'message-base']]);
    const identityLifecycle = new DiscordProgressIdentityLifecycle();
    let receivedSignal: AbortSignal | undefined;
    const edit = vi
      .fn<
        (
          messageId: string,
          body: Record<string, unknown>,
          signal?: AbortSignal,
        ) => Promise<void>
      >()
      .mockImplementationOnce(async (_messageId, _body, signal) => {
        receivedSignal = signal;
        await new Promise<void>(() => undefined);
      })
      .mockResolvedValue(undefined);
    const base = {
      routeKey: 'dc:channel-1\n',
      key: 'progress-1',
      activeMessages,
      identityLifecycle,
      options: {},
      post: vi.fn(async () => ({ externalMessageId: 'unexpected' })),
      edit,
    };

    const hung = sendDiscordProgressUpdateForRoute({
      ...base,
      text: 'hung',
    });
    const hungResult = expect(hung).rejects.toThrow(
      'Discord progress mutation did not settle after abort grace',
    );
    await Promise.resolve();
    const queued = sendDiscordProgressUpdateForRoute({
      ...base,
      text: 'newest',
    });

    await vi.advanceTimersByTimeAsync(45_000);
    expect(receivedSignal?.aborted).toBe(true);
    expect(edit).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(edit).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);

    await hungResult;
    await expect(queued).resolves.toBe(true);
    expect(edit).toHaveBeenCalledTimes(2);
    expect(identityLifecycle.mutationQueue.pendingByProgressKey.size).toBe(0);
    vi.useRealTimers();
  });

  it('ignores a provider settlement after the abort grace expires', async () => {
    vi.useFakeTimers();
    const delayedPost = deferred<{
      externalMessageId: string;
      deliveredParts: number;
      totalParts: number;
    }>();
    const activeMessages = new Map<string, string>();
    const identityLifecycle = new DiscordProgressIdentityLifecycle();
    const post = vi.fn(async () => delayedPost.promise);
    const edit = vi.fn(async () => undefined);
    const base = {
      routeKey: 'dc:channel-1\n',
      key: 'progress-1',
      activeMessages,
      identityLifecycle,
      post,
      edit,
    };

    const delayedCreate = sendDiscordProgressUpdateForRoute({
      ...base,
      text: 'Working',
      options: {},
    });
    const delayedResult = expect(delayedCreate).rejects.toThrow(
      'Discord progress mutation did not settle after abort grace',
    );
    await vi.advanceTimersByTimeAsync(50_000);
    await delayedResult;

    delayedPost.resolve({
      externalMessageId: 'message-after-retention',
      deliveredParts: 1,
      totalParts: 1,
    });
    await vi.runAllTicks();
    expect(activeMessages.has('progress-1')).toBe(false);

    await expect(
      sendDiscordProgressUpdateForRoute({
        ...base,
        text: 'Still working',
        options: { replaceOnly: true },
      }),
    ).resolves.toBe(false);
    expect(edit).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('adopts a post that lands after lifecycle state-cap eviction', async () => {
    const delayedPost = deferred<{
      externalMessageId: string;
      deliveredParts: number;
      totalParts: number;
    }>();
    const activeMessages = new Map<string, string>();
    const identityLifecycle = new DiscordProgressIdentityLifecycle();
    const post = vi.fn(async () => delayedPost.promise);
    const edit = vi.fn(async () => undefined);
    const base = {
      routeKey: 'dc:channel-1\n',
      key: 'progress-1',
      activeMessages,
      identityLifecycle,
      post,
      edit,
    };

    const delayedCreate = sendDiscordProgressUpdateForRoute({
      ...base,
      text: 'Working',
      options: {},
    });
    await Promise.resolve();

    for (let index = 0; index < 5_000; index += 1) {
      identityLifecycle.prepare({
        routeKey: `dc:cap-${index}\n`,
        progressKey: `progress-${index}`,
        text: 'Working',
        options: {},
        hasHandle: false,
      });
    }

    delayedPost.resolve({
      externalMessageId: 'message-after-cap-eviction',
      deliveredParts: 1,
      totalParts: 1,
    });
    await expect(delayedCreate).resolves.toBe(true);
    expect(activeMessages.get('progress-1')).toBe('message-after-cap-eviction');
  });

  it('keeps an in-deadline pending tombstone through tombstone-cap pressure', async () => {
    vi.useFakeTimers();
    const delayedPost = deferred<{
      externalMessageId: string;
      deliveredParts: number;
      totalParts: number;
    }>();
    const activeMessages = new Map<string, string>();
    const identityLifecycle = new DiscordProgressIdentityLifecycle();
    const create = sendDiscordProgressUpdateForRoute({
      routeKey: 'dc:protected\n',
      key: 'progress-protected',
      activeMessages,
      identityLifecycle,
      text: 'Working',
      options: {},
      post: async () => delayedPost.promise,
      edit: vi.fn(async () => undefined),
    });
    await Promise.resolve();

    type InternalState = {
      routeKey: string;
      progressKey: string;
      generation: number;
      newestSequence: number;
      definitiveMissing: boolean;
      attempts: Map<number, { invalidated?: boolean }>;
      retentionTimer?: ReturnType<typeof setTimeout>;
    };
    const internal = identityLifecycle as unknown as {
      stateByProgressKey: Map<string, InternalState>;
      createTombstoneByProgressKey: Map<string, InternalState>;
      retainCreateTombstone(key: string, state: InternalState): void;
    };
    const protectedKey = JSON.stringify([
      'dc:protected\n',
      'progress-protected',
    ]);
    const protectedState = internal.stateByProgressKey.get(protectedKey)!;
    if (protectedState.retentionTimer) {
      clearTimeout(protectedState.retentionTimer);
    }
    internal.stateByProgressKey.delete(protectedKey);
    internal.retainCreateTombstone(protectedKey, protectedState);
    for (let index = 0; index < 4_999; index += 1) {
      internal.createTombstoneByProgressKey.set(`filler-${index}`, {
        routeKey: `dc:filler-${index}\n`,
        progressKey: `progress-filler-${index}`,
        generation: index + 1,
        newestSequence: -1,
        definitiveMissing: false,
        attempts: new Map(),
      });
    }
    internal.retainCreateTombstone('overflow', {
      routeKey: 'dc:overflow\n',
      progressKey: 'progress-overflow',
      generation: 5_001,
      newestSequence: -1,
      definitiveMissing: false,
      attempts: new Map(),
    });

    expect(internal.createTombstoneByProgressKey.has(protectedKey)).toBe(true);
    expect([...protectedState.attempts.values()][0]?.invalidated).not.toBe(
      true,
    );

    delayedPost.resolve({
      externalMessageId: 'message-protected',
      deliveredParts: 1,
      totalParts: 1,
    });
    await expect(create).resolves.toBe(true);
    expect(activeMessages.get('progress-protected')).toBe('message-protected');
    vi.useRealTimers();
  });

  it('deletes a create id that lands after its attempt is invalidated', async () => {
    const delayedPost = deferred<{
      externalMessageId: string;
      deliveredParts: number;
      totalParts: number;
    }>();
    const activeMessages = new Map<string, string>();
    const identityLifecycle = new DiscordProgressIdentityLifecycle();
    const deleteMessage = vi.fn(async () => undefined);
    const create = sendDiscordProgressUpdateForRoute({
      routeKey: 'dc:invalidated\n',
      key: 'progress-invalidated',
      activeMessages,
      identityLifecycle,
      text: 'Working',
      options: {},
      post: async () => delayedPost.promise,
      edit: vi.fn(async () => undefined),
      delete: deleteMessage,
    });
    await Promise.resolve();

    const internal = identityLifecycle as unknown as {
      stateByProgressKey: Map<
        string,
        { attempts: Map<number, { invalidated?: boolean }> }
      >;
    };
    const state = internal.stateByProgressKey.get(
      JSON.stringify(['dc:invalidated\n', 'progress-invalidated']),
    )!;
    [...state.attempts.values()][0]!.invalidated = true;

    delayedPost.resolve({
      externalMessageId: 'message-invalidated',
      deliveredParts: 1,
      totalParts: 1,
    });
    await expect(create).resolves.toBe(true);

    expect(deleteMessage).toHaveBeenCalledWith(
      'message-invalidated',
      expect.any(AbortSignal),
    );
    expect(activeMessages.has('progress-invalidated')).toBe(false);
  });
});
