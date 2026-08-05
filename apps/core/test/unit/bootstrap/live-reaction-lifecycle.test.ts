import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createLiveReactionLifecycle } from '@core/app/bootstrap/live-reaction-lifecycle.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe('live reaction lifecycle', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('flips seen to running after five seconds and restores seen on first output', async () => {
    const addReaction = vi.fn(async () => undefined);
    const removeReaction = vi.fn(async () => undefined);
    const lifecycle = createLiveReactionLifecycle({
      addReaction,
      removeReaction,
      removalMode: 'exact',
    });

    await lifecycle.onFirstProgress({ jid: 'sl:C1', messageRef: 'm-1' });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(removeReaction).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(removeReaction).toHaveBeenCalledWith(
      'sl:C1',
      'm-1',
      'seen',
      undefined,
    );
    expect(addReaction).toHaveBeenCalledWith(
      'sl:C1',
      'm-1',
      'running',
      undefined,
    );

    await lifecycle.onFirstVisibleOutput();
    expect(removeReaction).toHaveBeenLastCalledWith(
      'sl:C1',
      'm-1',
      'running',
      undefined,
    );
    expect(addReaction).toHaveBeenLastCalledWith(
      'sl:C1',
      'm-1',
      'seen',
      undefined,
    );
  });

  it('terminal cleanup before output leaves seen and never adds running', async () => {
    const addReaction = vi.fn(async () => undefined);
    const removeReaction = vi.fn(async () => undefined);
    const lifecycle = createLiveReactionLifecycle({
      addReaction,
      removeReaction,
      removalMode: 'exact',
    });

    await lifecycle.onFirstProgress({ jid: 'sl:C1', messageRef: 'm-1' });
    await lifecycle.onTerminal();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(addReaction).not.toHaveBeenCalledWith(
      'sl:C1',
      'm-1',
      'running',
      undefined,
    );
    expect(addReaction).toHaveBeenLastCalledWith(
      'sl:C1',
      'm-1',
      'seen',
      undefined,
    );
  });

  it('restores seen at terminal even when the admission reaction never settles', async () => {
    const firstAdd = deferred();
    const addReaction = vi
      .fn()
      .mockImplementationOnce(() => firstAdd.promise)
      .mockResolvedValue(undefined);
    const removeReaction = vi.fn(async () => undefined);
    const lifecycle = createLiveReactionLifecycle({
      addReaction,
      removeReaction,
      removalMode: 'exact',
    });

    void lifecycle.onFirstProgress({ jid: 'sl:C1', messageRef: 'm-1' });
    await vi.advanceTimersByTimeAsync(0);
    await lifecycle.onTerminal();

    expect(removeReaction).toHaveBeenCalledWith(
      'sl:C1',
      'm-1',
      'running',
      undefined,
    );
    expect(addReaction).toHaveBeenCalledTimes(2);
    expect(addReaction).toHaveBeenLastCalledWith(
      'sl:C1',
      'm-1',
      'seen',
      undefined,
    );
  });

  it('serializes timer and output cleanup when removal is already in flight', async () => {
    const releaseSeenRemoval = deferred();
    const addReaction = vi.fn(async () => undefined);
    const removeReaction = vi.fn(async (_jid, _ref, emoji) => {
      if (emoji === 'seen') await releaseSeenRemoval.promise;
    });
    const lifecycle = createLiveReactionLifecycle({
      addReaction,
      removeReaction,
      removalMode: 'exact',
    });

    await lifecycle.onFirstProgress({ jid: 'sl:C1', messageRef: 'm-1' });
    await vi.advanceTimersByTimeAsync(5_000);
    const outputCleanup = lifecycle.onFirstVisibleOutput();
    releaseSeenRemoval.resolve();
    await outputCleanup;

    expect(addReaction).not.toHaveBeenCalledWith(
      'sl:C1',
      'm-1',
      'running',
      undefined,
    );
    expect(addReaction).toHaveBeenLastCalledWith(
      'sl:C1',
      'm-1',
      'seen',
      undefined,
    );
  });

  it('replaces reactions directly when the provider removal mode is all', async () => {
    const events: string[] = [];
    const addReaction = vi.fn(async (_jid, _ref, emoji) => {
      events.push(`add:${emoji}`);
    });
    const removeReaction = vi.fn(async (_jid, _ref, emoji) => {
      events.push(`remove:${emoji}`);
    });
    const lifecycle = createLiveReactionLifecycle({
      addReaction,
      removeReaction,
      removalMode: 'all',
    });

    await lifecycle.onFirstProgress({ jid: 'tg:1', messageRef: 'm-1' });
    await vi.advanceTimersByTimeAsync(5_000);
    await lifecycle.onTerminal();

    expect(events).toEqual(['add:seen', 'add:running', 'add:seen']);
    expect(removeReaction).not.toHaveBeenCalled();
  });

  it('uses the selected reaction target thread for every flip operation', async () => {
    const addReaction = vi.fn(async () => undefined);
    const removeReaction = vi.fn(async () => undefined);
    const lifecycle = createLiveReactionLifecycle({
      addReaction,
      removeReaction,
      removalMode: 'exact',
      options: { threadId: 'newest-thread' },
    });

    await lifecycle.onFirstProgress({
      jid: 'dc:parent-1',
      messageRef: 'message-1',
      threadId: 'selected-thread',
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await lifecycle.onTerminal();

    for (const call of [
      ...addReaction.mock.calls,
      ...removeReaction.mock.calls,
    ]) {
      expect(call[3]).toEqual({ threadId: 'selected-thread' });
    }
  });

  it('clears an inherited thread when the selected reaction target is threadless', async () => {
    const addReaction = vi.fn(async () => undefined);
    const removeReaction = vi.fn(async () => undefined);
    const lifecycle = createLiveReactionLifecycle({
      addReaction,
      removeReaction,
      removalMode: 'exact',
      options: { providerAccountId: 'account-1', threadId: 'newest-thread' },
    });

    await lifecycle.onFirstProgress({
      jid: 'dc:parent-1',
      messageRef: 'plain-message-1',
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await lifecycle.onTerminal();

    for (const call of [
      ...addReaction.mock.calls,
      ...removeReaction.mock.calls,
    ]) {
      expect(call[3]).toEqual({ providerAccountId: 'account-1' });
    }
  });
});
