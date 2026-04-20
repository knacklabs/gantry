import { describe, expect, it } from 'vitest';

import { MemoryMaintenanceQueue } from '@core/memory/maintenance-queue.js';

describe('MemoryMaintenanceQueue', () => {
  it('dedupes only matching dedupe keys', async () => {
    const queue = new MemoryMaintenanceQueue({ maxPending: 10 });

    let releaseFirst: (() => void) | null = null;
    const firstTask = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.enqueueDetailed(
      'team',
      async () => {
        await firstTask;
      },
      'dream:team',
    );
    const deduped = queue.enqueueDetailed('team', async () => {}, 'dream:team');
    const differentKey = queue.enqueueDetailed(
      'team',
      async () => {},
      'cleanup:team',
    );

    expect(first).toEqual({ queued: true, deduped: false, reason: 'queued' });
    expect(deduped).toEqual({
      queued: false,
      deduped: true,
      reason: 'deduped',
    });
    expect(differentKey).toEqual({
      queued: true,
      deduped: false,
      reason: 'queued',
    });

    releaseFirst?.();
    await queue.enqueueAndWait('team', async () => {}, 'final:team');
  });

  it('tracks running status per group even with keyed dedupe', async () => {
    const queue = new MemoryMaintenanceQueue({ maxPending: 10 });
    let unblock: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });

    const runPromise = queue.enqueueAndWait(
      'team',
      async () => {
        await gate;
      },
      'dream:team',
    );

    expect(queue.isRunningForGroup('team')).toBe(true);

    unblock?.();
    await runPromise;
    expect(queue.isRunningForGroup('team')).toBe(false);
  });
});
