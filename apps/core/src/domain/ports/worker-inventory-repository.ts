export type WorkerInventoryCachePrewarmStatus =
  | 'pending'
  | 'succeeded'
  | 'skipped'
  | 'failed';

export interface WorkerInventoryCachePrewarmSnapshot {
  pending: number;
  succeeded: number;
  skipped: number;
  failed: number;
}

export interface WorkerInventoryCacheShapeSnapshot {
  cacheShapeKey: string;
  status: WorkerInventoryCachePrewarmStatus;
  workers: number;
}

export interface WorkerInventoryWarmPoolSnapshot {
  availableTarget: number;
  genericAvailable: number;
  genericStarting: number;
  boundActive: number;
  boundIdle: number;
  boundDraining: number;
  maxBoundWorkers: number;
  cachePrewarm: WorkerInventoryCachePrewarmSnapshot;
  cacheShapes: WorkerInventoryCacheShapeSnapshot[];
}

export interface WorkerInventoryQueueSnapshot {
  activeMessageRuns: number;
  pendingConversationKeys: number;
  maxMessageRuns: number;
}

export interface WorkerInventorySnapshot {
  instanceId: string;
  hostname: string;
  startedAt: string;
  lastHeartbeatAt: string;
  warmPool: WorkerInventoryWarmPoolSnapshot;
  queue: WorkerInventoryQueueSnapshot;
}

export interface SaveWorkerInventorySnapshotInput {
  appId: string;
  snapshot: WorkerInventorySnapshot;
  now?: string;
}

export interface ListWorkerInventorySnapshotsInput {
  appId: string;
  limit?: number;
}

export interface DeleteWorkerInventorySnapshotsOlderThanInput {
  appId: string;
  before: string;
}

export interface WorkerInventorySnapshotRepository {
  saveSnapshot(input: SaveWorkerInventorySnapshotInput): Promise<void>;
  listSnapshots(
    input: ListWorkerInventorySnapshotsInput,
  ): Promise<WorkerInventorySnapshot[]>;
  deleteSnapshotsOlderThan(
    input: DeleteWorkerInventorySnapshotsOlderThanInput,
  ): Promise<number>;
}
