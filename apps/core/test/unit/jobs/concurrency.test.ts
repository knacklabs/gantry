import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  acquireRunSlot,
  resetSchedulerRunSlots,
} from '@core/jobs/concurrency.js';

describe('scheduler run slots', () => {
  afterEach(() => {
    vi.useRealTimers();
    resetSchedulerRunSlots();
  });

  it('serializes concurrent runs for the same group scope by default', async () => {
    vi.useFakeTimers();
    const releaseFirst = await acquireRunSlot('agent-a');
    let secondAcquired = false;
    const second = acquireRunSlot('agent-a').then((release) => {
      secondAcquired = true;
      return release;
    });

    await vi.advanceTimersByTimeAsync(500);
    expect(secondAcquired).toBe(false);

    releaseFirst();
    await vi.advanceTimersByTimeAsync(100);
    const releaseSecond = await second;
    expect(secondAcquired).toBe(true);

    releaseSecond();
  });

  it('allows different group scopes to run concurrently', async () => {
    vi.useFakeTimers();
    const releaseFirst = await acquireRunSlot('agent-a');
    let secondAcquired = false;
    const second = acquireRunSlot('agent-b').then((release) => {
      secondAcquired = true;
      return release;
    });

    await vi.advanceTimersByTimeAsync(0);
    const releaseSecond = await second;
    expect(secondAcquired).toBe(true);

    releaseSecond();
    releaseFirst();
  });
});
