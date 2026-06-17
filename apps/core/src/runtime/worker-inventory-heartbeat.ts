import type {
  SaveWorkerInventorySnapshotInput,
  WorkerInventorySnapshot,
} from '../domain/ports/worker-inventory-repository.js';

export interface WorkerInventoryHeartbeatHandle {
  close(): void;
}

export interface WorkerInventoryHeartbeatLogger {
  warn(payload: Record<string, unknown>, message: string): void;
}

export interface WorkerInventoryHeartbeatOptions {
  appId: string;
  getSnapshot: () => WorkerInventorySnapshot;
  saveSnapshot: (input: SaveWorkerInventorySnapshotInput) => Promise<void>;
  intervalMs?: number;
  logger: WorkerInventoryHeartbeatLogger;
}

const DEFAULT_WORKER_INVENTORY_HEARTBEAT_MS = 5_000;

export function startWorkerInventoryHeartbeat(
  options: WorkerInventoryHeartbeatOptions,
): WorkerInventoryHeartbeatHandle {
  let closed = false;
  let inFlight = false;

  const writeSnapshot = () => {
    if (closed || inFlight) return;
    inFlight = true;
    void options
      .saveSnapshot({
        appId: options.appId,
        snapshot: options.getSnapshot(),
      })
      .catch((err) => {
        options.logger.warn(
          { err },
          'Runtime worker inventory heartbeat failed',
        );
      })
      .finally(() => {
        inFlight = false;
      });
  };

  const interval = setInterval(
    writeSnapshot,
    options.intervalMs ?? DEFAULT_WORKER_INVENTORY_HEARTBEAT_MS,
  );
  interval.unref?.();
  writeSnapshot();

  return {
    close: () => {
      closed = true;
      clearInterval(interval);
    },
  };
}
