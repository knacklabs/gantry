import type {
  WorkerInventoryCachePrewarmSnapshot,
  WorkerInventoryCacheShapeSnapshot,
  WorkerInventoryQueueSnapshot,
  WorkerInventorySnapshot,
  WorkerInventoryWarmPoolSnapshot,
} from '../domain/ports/worker-inventory-repository.js';

export type {
  WorkerInventoryCachePrewarmSnapshot,
  WorkerInventoryCachePrewarmStatus,
  WorkerInventoryCacheShapeSnapshot,
  WorkerInventoryQueueSnapshot,
  WorkerInventorySnapshot,
  WorkerInventoryWarmPoolSnapshot,
} from '../domain/ports/worker-inventory-repository.js';

export type WorkerInventoryHealth = 'healthy' | 'stale';

export interface WorkerInventoryInstanceView extends WorkerInventorySnapshot {
  health: WorkerInventoryHealth;
}

export interface WorkerInventoryTotals {
  instances: number;
  warmPool: WorkerInventoryWarmPoolSnapshot;
  queue: WorkerInventoryQueueSnapshot;
}

export interface WorkerInventorySummary {
  instances: WorkerInventoryInstanceView[];
  healthyTotals: WorkerInventoryTotals;
}

export interface SummarizeWorkerInventorySnapshotsInput {
  snapshots: readonly WorkerInventorySnapshot[];
  now: Date;
  staleAfterMs: number;
}

const EMPTY_WARM_POOL_TOTALS: WorkerInventoryWarmPoolSnapshot = {
  availableTarget: 0,
  genericAvailable: 0,
  genericStarting: 0,
  boundActive: 0,
  boundIdle: 0,
  boundDraining: 0,
  maxBoundWorkers: 0,
  cachePrewarm: {
    pending: 0,
    succeeded: 0,
    skipped: 0,
    failed: 0,
  },
  cacheShapes: [],
};

const EMPTY_QUEUE_TOTALS: WorkerInventoryQueueSnapshot = {
  activeMessageRuns: 0,
  pendingConversationKeys: 0,
  maxMessageRuns: 0,
};

function addWarmPoolTotals(
  current: WorkerInventoryWarmPoolSnapshot,
  next: WorkerInventoryWarmPoolSnapshot,
): WorkerInventoryWarmPoolSnapshot {
  return {
    availableTarget: current.availableTarget + next.availableTarget,
    genericAvailable: current.genericAvailable + next.genericAvailable,
    genericStarting: current.genericStarting + next.genericStarting,
    boundActive: current.boundActive + next.boundActive,
    boundIdle: current.boundIdle + next.boundIdle,
    boundDraining: current.boundDraining + next.boundDraining,
    maxBoundWorkers: current.maxBoundWorkers + next.maxBoundWorkers,
    cachePrewarm: addCachePrewarmTotals(
      current.cachePrewarm,
      next.cachePrewarm,
    ),
    cacheShapes: addCacheShapeTotals(current.cacheShapes, next.cacheShapes),
  };
}

function addCachePrewarmTotals(
  current: WorkerInventoryCachePrewarmSnapshot,
  next: WorkerInventoryCachePrewarmSnapshot,
): WorkerInventoryCachePrewarmSnapshot {
  return {
    pending: current.pending + next.pending,
    succeeded: current.succeeded + next.succeeded,
    skipped: current.skipped + next.skipped,
    failed: current.failed + next.failed,
  };
}

function addCacheShapeTotals(
  current: readonly WorkerInventoryCacheShapeSnapshot[],
  next: readonly WorkerInventoryCacheShapeSnapshot[],
): WorkerInventoryCacheShapeSnapshot[] {
  const totals = new Map<string, WorkerInventoryCacheShapeSnapshot>();
  for (const shape of [...current, ...next]) {
    const key = `${shape.cacheShapeKey}\u0000${shape.status}`;
    const existing = totals.get(key);
    totals.set(key, {
      cacheShapeKey: shape.cacheShapeKey,
      status: shape.status,
      workers: (existing?.workers ?? 0) + shape.workers,
    });
  }
  return [...totals.values()].sort(
    (left, right) =>
      left.cacheShapeKey.localeCompare(right.cacheShapeKey) ||
      left.status.localeCompare(right.status),
  );
}

function addQueueTotals(
  current: WorkerInventoryQueueSnapshot,
  next: WorkerInventoryQueueSnapshot,
): WorkerInventoryQueueSnapshot {
  return {
    activeMessageRuns: current.activeMessageRuns + next.activeMessageRuns,
    pendingConversationKeys:
      current.pendingConversationKeys + next.pendingConversationKeys,
    maxMessageRuns: current.maxMessageRuns + next.maxMessageRuns,
  };
}

function snapshotHealth(
  snapshot: WorkerInventorySnapshot,
  now: Date,
  staleAfterMs: number,
): WorkerInventoryHealth {
  const lastHeartbeatMs = Date.parse(snapshot.lastHeartbeatAt);
  if (!Number.isFinite(lastHeartbeatMs)) return 'stale';
  return now.getTime() - lastHeartbeatMs > staleAfterMs ? 'stale' : 'healthy';
}

export function summarizeWorkerInventorySnapshots(
  input: SummarizeWorkerInventorySnapshotsInput,
): WorkerInventorySummary {
  const instances = input.snapshots.map((snapshot) => ({
    ...snapshot,
    health: snapshotHealth(snapshot, input.now, input.staleAfterMs),
  }));
  const healthyTotals = instances.reduce<WorkerInventoryTotals>(
    (totals, instance) => {
      if (instance.health !== 'healthy') return totals;
      return {
        instances: totals.instances + 1,
        warmPool: addWarmPoolTotals(totals.warmPool, instance.warmPool),
        queue: addQueueTotals(totals.queue, instance.queue),
      };
    },
    {
      instances: 0,
      warmPool: EMPTY_WARM_POOL_TOTALS,
      queue: EMPTY_QUEUE_TOTALS,
    },
  );

  return { instances, healthyTotals };
}
