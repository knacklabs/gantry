import { MEMORY_MAINTENANCE_MAX_PENDING } from '../core/config.js';
import { logger } from '../core/logger.js';

type MaintenanceTask = () => Promise<void>;

interface PendingTask {
  dedupeKey: string;
  groupFolder: string;
  task: MaintenanceTask;
  resolve?: () => void;
  reject?: (err: unknown) => void;
}

interface MemoryMaintenanceQueueOptions {
  maxPending?: number;
  onError?: (groupFolder: string, err: unknown) => void;
}

export interface MemoryMaintenanceQueueEnqueueResult {
  queued: boolean;
  deduped: boolean;
  reason: 'queued' | 'deduped' | 'full' | 'invalid';
}

export class MemoryMaintenanceQueue {
  private readonly maxPending: number;
  private readonly onError: (groupFolder: string, err: unknown) => void;
  private running = false;
  private readonly pending: PendingTask[] = [];
  private readonly inflight = new Set<string>();
  private readonly inflightGroups = new Set<string>();

  constructor(options: MemoryMaintenanceQueueOptions = {}) {
    this.maxPending = Math.max(
      1,
      options.maxPending ?? MEMORY_MAINTENANCE_MAX_PENDING,
    );
    this.onError =
      options.onError ||
      ((groupFolder, err) => {
        logger.error({ err, groupFolder }, 'memory_maintenance_failed');
      });
  }

  enqueue(
    groupFolder: string,
    task: MaintenanceTask,
    dedupeKey?: string,
  ): boolean {
    return this.enqueueInternal(groupFolder, task, undefined, dedupeKey).queued;
  }

  enqueueDetailed(
    groupFolder: string,
    task: MaintenanceTask,
    dedupeKey?: string,
  ): MemoryMaintenanceQueueEnqueueResult {
    return this.enqueueInternal(groupFolder, task, undefined, dedupeKey);
  }

  async enqueueAndWait(
    groupFolder: string,
    task: MaintenanceTask,
    dedupeKey?: string,
  ): Promise<MemoryMaintenanceQueueEnqueueResult> {
    let resolveRun: (() => void) | null = null;
    let rejectRun: ((err: unknown) => void) | null = null;
    const runCompleted = new Promise<void>((resolve, reject) => {
      resolveRun = resolve;
      rejectRun = reject;
    });
    const result = this.enqueueInternal(
      groupFolder,
      task,
      {
        resolve: () => resolveRun?.(),
        reject: (err) => rejectRun?.(err),
      },
      dedupeKey,
    );
    if (!result.queued) return result;
    await runCompleted;
    return result;
  }

  getPendingCount(): number {
    return this.pending.length;
  }

  isRunningForGroup(groupFolder: string): boolean {
    return this.inflightGroups.has(groupFolder);
  }

  private enqueueInternal(
    groupFolder: string,
    task: MaintenanceTask,
    callbacks?: {
      resolve: () => void;
      reject: (err: unknown) => void;
    },
    dedupeKeyOverride?: string,
  ): MemoryMaintenanceQueueEnqueueResult {
    const dedupeKey = dedupeKeyOverride?.trim() || groupFolder.trim();
    if (!groupFolder.trim() || !dedupeKey) {
      return { queued: false, deduped: false, reason: 'invalid' };
    }
    if (this.inflight.has(dedupeKey)) {
      return { queued: false, deduped: true, reason: 'deduped' };
    }
    if (this.pending.some((entry) => entry.dedupeKey === dedupeKey)) {
      return { queued: false, deduped: true, reason: 'deduped' };
    }
    if (this.pending.length >= this.maxPending) {
      logger.warn(
        {
          groupFolder,
          maxPending: this.maxPending,
        },
        'memory_maintenance_queue_full',
      );
      return { queued: false, deduped: false, reason: 'full' };
    }
    this.pending.push({
      dedupeKey,
      groupFolder,
      task,
      resolve: callbacks?.resolve,
      reject: callbacks?.reject,
    });
    this.pump();
    return { queued: true, deduped: false, reason: 'queued' };
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length > 0) {
        const next = this.pending.shift();
        if (!next) break;
        this.inflight.add(next.dedupeKey);
        this.inflightGroups.add(next.groupFolder);
        try {
          await next.task();
          next.resolve?.();
        } catch (err) {
          this.onError(next.groupFolder, err);
          next.reject?.(err);
        } finally {
          this.inflight.delete(next.dedupeKey);
          this.inflightGroups.delete(next.groupFolder);
        }
      }
    } finally {
      this.running = false;
    }
  }
}

let maintenanceQueueSingleton: MemoryMaintenanceQueue | null = null;

export function getMemoryMaintenanceQueue(): MemoryMaintenanceQueue {
  if (!maintenanceQueueSingleton) {
    maintenanceQueueSingleton = new MemoryMaintenanceQueue();
  }
  return maintenanceQueueSingleton;
}

export function resetMemoryMaintenanceQueueForTests(): void {
  maintenanceQueueSingleton = null;
}
