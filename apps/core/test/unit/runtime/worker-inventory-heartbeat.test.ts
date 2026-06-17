import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkerInventorySnapshot } from '@core/runtime/worker-inventory-snapshot.js';
import { startWorkerInventoryHeartbeat } from '@core/runtime/worker-inventory-heartbeat.js';

const SNAPSHOT: WorkerInventorySnapshot = {
  instanceId: 'runtime:test',
  hostname: 'test-host',
  startedAt: '2026-06-17T00:00:00.000Z',
  lastHeartbeatAt: '2026-06-17T00:00:05.000Z',
  warmPool: {
    availableTarget: 1,
    genericAvailable: 1,
    genericStarting: 0,
    boundActive: 0,
    boundIdle: 0,
    boundDraining: 0,
    maxBoundWorkers: 3,
    cachePrewarm: {
      pending: 0,
      succeeded: 0,
      skipped: 1,
      failed: 0,
    },
    cacheShapes: [],
  },
  queue: {
    activeMessageRuns: 0,
    pendingConversationKeys: 0,
    maxMessageRuns: 3,
  },
};

describe('startWorkerInventoryHeartbeat', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes an immediate snapshot, repeats at the heartbeat interval, and stops cleanly', async () => {
    vi.useFakeTimers();
    const saveSnapshot = vi.fn(async () => undefined);
    const logger = { warn: vi.fn() };

    const handle = startWorkerInventoryHeartbeat({
      appId: 'default',
      getSnapshot: () => SNAPSHOT,
      saveSnapshot,
      intervalMs: 1_000,
      logger,
    });

    expect(saveSnapshot).toHaveBeenCalledTimes(1);
    expect(saveSnapshot).toHaveBeenLastCalledWith({
      appId: 'default',
      snapshot: SNAPSHOT,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(saveSnapshot).toHaveBeenCalledTimes(2);

    handle.close();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(saveSnapshot).toHaveBeenCalledTimes(2);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
