import { describe, expect, it, vi } from 'vitest';

import {
  RUNTIME_EVENT_RETENTION_SWEEP_INTERVAL_MS,
  sweepRuntimeEventsIfDue,
} from '@core/infrastructure/pgboss/runtime-event-retention.js';

describe('runtime-event retention', () => {
  it('retries runtime-event retention after a partial or failed sweep', async () => {
    const now = Date.parse('2026-08-12T12:00:00.000Z');
    const sweep = vi
      .fn()
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce({ deleted: 500, more: true })
      .mockResolvedValueOnce({ deleted: 2, more: false });

    let lastSweepAt: number | null = null;
    lastSweepAt = await sweepRuntimeEventsIfDue({ sweep, lastSweepAt, now });
    expect(lastSweepAt).toBeNull();
    lastSweepAt = await sweepRuntimeEventsIfDue({ sweep, lastSweepAt, now });
    expect(lastSweepAt).toBeNull();
    lastSweepAt = await sweepRuntimeEventsIfDue({ sweep, lastSweepAt, now });
    expect(lastSweepAt).toBe(now);
    expect(sweep).toHaveBeenCalledTimes(3);
    expect(sweep).toHaveBeenCalledWith('2026-07-13T12:00:00.000Z');

    await sweepRuntimeEventsIfDue({
      sweep,
      lastSweepAt,
      now: now + RUNTIME_EVENT_RETENTION_SWEEP_INTERVAL_MS - 1,
    });
    expect(sweep).toHaveBeenCalledTimes(3);
  });
});
