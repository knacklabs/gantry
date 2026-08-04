import { describe, expect, it } from 'vitest';

import { withObserverDigestEditLock } from '@core/channels/observer-digest-edit-lock.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('withObserverDigestEditLock', () => {
  it('serializes edits on the same key so the later click rebuilds from the earlier commit', async () => {
    // Models the concurrency bug: click A applies first but its provider edit
    // lands LAST. Its snapshot must include B's later commit, so B is not
    // resurrected. The lock forces B to run only after A fully completes.
    const durable = new Set<string>();
    let message = new Set<string>();
    const click = (id: string, applyMs: number, editMs: number) =>
      withObserverDigestEditLock('msg-1', async () => {
        await sleep(applyMs);
        durable.add(id); // atomic apply/commit
        const snapshot = new Set(durable); // rebuild from committed truth
        await sleep(editMs); // provider round-trip
        message = snapshot; // provider edit lands
      });

    await Promise.all([click('a', 0, 30), click('b', 5, 0)]);

    // Both insights settled; the later edit did not drop the other's marker.
    expect(message).toEqual(new Set(['a', 'b']));
    expect(durable).toEqual(new Set(['a', 'b']));
  });

  it('does not block edits on different keys', async () => {
    const order: string[] = [];
    await Promise.all([
      withObserverDigestEditLock('a', async () => {
        await sleep(20);
        order.push('a');
      }),
      withObserverDigestEditLock('b', async () => {
        order.push('b'); // runs immediately, before 'a' finishes
      }),
    ]);
    expect(order).toEqual(['b', 'a']);
  });

  it('a rejected edit does not wedge the chain for the next click', async () => {
    await expect(
      withObserverDigestEditLock('k', async () => {
        throw new Error('edit failed');
      }),
    ).rejects.toThrow('edit failed');
    // Next click on the same key still runs.
    await expect(
      withObserverDigestEditLock('k', async () => 'ok'),
    ).resolves.toBe('ok');
  });
});
