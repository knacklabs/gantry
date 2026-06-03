import { MEMORY_MAINTENANCE_MAX_PENDING } from '../config/index.js';
import { logger } from '../infrastructure/logging/logger.js';
import { abortReason } from '../shared/memory-dreaming-timeout.js';

type MaintenanceTask = () => Promise<void>;

interface PendingTask {
  dedupeKey: string;
  workspaceFolder: string;
  task: MaintenanceTask;
  signal?: AbortSignal;
  resolve?: () => void;
  reject?: (err: unknown) => void;
}

interface MemoryMaintenanceQueueOptions {
  maxPending?: number;
  onError?: (workspaceFolder: string, err: unknown) => void;
}

export interface MemoryMaintenanceQueueEnqueueResult {
  queued: boolean;
  deduped: boolean;
  reason: 'queued' | 'deduped' | 'full' | 'invalid';
}

interface InternalEnqueueResult {
  result: MemoryMaintenanceQueueEnqueueResult;
  entry?: PendingTask;
}

export class MemoryMaintenanceQueue {
  private readonly maxPending: number;
  private readonly onError: (workspaceFolder: string, err: unknown) => void;
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
      ((workspaceFolder, err) => {
        logger.error({ err, workspaceFolder }, 'memory_maintenance_failed');
      });
  }

  enqueue(
    workspaceFolder: string,
    task: MaintenanceTask,
    dedupeKey?: string,
  ): boolean {
    return this.enqueueInternal(workspaceFolder, task, undefined, dedupeKey)
      .result.queued;
  }

  enqueueDetailed(
    workspaceFolder: string,
    task: MaintenanceTask,
    dedupeKey?: string,
  ): MemoryMaintenanceQueueEnqueueResult {
    return this.enqueueInternal(workspaceFolder, task, undefined, dedupeKey)
      .result;
  }

  async enqueueAndWait(
    workspaceFolder: string,
    task: MaintenanceTask,
    dedupeKey?: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<MemoryMaintenanceQueueEnqueueResult> {
    options.signal?.throwIfAborted();
    let resolveRun: (() => void) | null = null;
    let rejectRun: ((err: unknown) => void) | null = null;
    const runCompleted = new Promise<void>((resolve, reject) => {
      resolveRun = resolve;
      rejectRun = reject;
    });
    const { result, entry } = this.enqueueInternal(
      workspaceFolder,
      task,
      {
        resolve: () => resolveRun?.(),
        reject: (err) => rejectRun?.(err),
      },
      dedupeKey,
      options,
    );
    if (!result.queued) return result;
    const onAbort = () => {
      if (entry && this.removePending(entry)) {
        rejectRun?.(abortReason(options.signal!));
      }
    };
    if (options.signal?.aborted) {
      onAbort();
    } else {
      options.signal?.addEventListener('abort', onAbort, { once: true });
    }
    try {
      await runCompleted;
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }
    return result;
  }

  getPendingCount(): number {
    return this.pending.length;
  }

  isRunningForGroup(workspaceFolder: string): boolean {
    return this.inflightGroups.has(workspaceFolder);
  }

  private enqueueInternal(
    workspaceFolder: string,
    task: MaintenanceTask,
    callbacks?: {
      resolve: () => void;
      reject: (err: unknown) => void;
    },
    dedupeKeyOverride?: string,
    options: { signal?: AbortSignal } = {},
  ): InternalEnqueueResult {
    const dedupeKey = dedupeKeyOverride?.trim() || workspaceFolder.trim();
    if (!workspaceFolder.trim() || !dedupeKey) {
      return {
        result: { queued: false, deduped: false, reason: 'invalid' },
      };
    }
    if (this.inflight.has(dedupeKey)) {
      return {
        result: { queued: false, deduped: true, reason: 'deduped' },
      };
    }
    if (this.pending.some((entry) => entry.dedupeKey === dedupeKey)) {
      return {
        result: { queued: false, deduped: true, reason: 'deduped' },
      };
    }
    if (this.pending.length >= this.maxPending) {
      logger.warn(
        {
          workspaceFolder,
          maxPending: this.maxPending,
        },
        'memory_maintenance_queue_full',
      );
      return {
        result: { queued: false, deduped: false, reason: 'full' },
      };
    }
    const entry: PendingTask = {
      dedupeKey,
      workspaceFolder,
      task,
      resolve: callbacks?.resolve,
      reject: callbacks?.reject,
    };
    if (options.signal) entry.signal = options.signal;
    this.pending.push(entry);
    this.pump();
    return {
      result: { queued: true, deduped: false, reason: 'queued' },
      entry,
    };
  }

  private removePending(entry: PendingTask): boolean {
    const index = this.pending.indexOf(entry);
    if (index < 0) return false;
    this.pending.splice(index, 1);
    return true;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length > 0) {
        const next = this.pending.shift();
        if (!next) break;
        if (next.signal?.aborted) {
          next.reject?.(abortReason(next.signal));
          continue;
        }
        this.inflight.add(next.dedupeKey);
        this.inflightGroups.add(next.workspaceFolder);
        try {
          await next.task();
          next.resolve?.();
        } catch (err) {
          this.onError(next.workspaceFolder, err);
          next.reject?.(err);
        } finally {
          this.inflight.delete(next.dedupeKey);
          this.inflightGroups.delete(next.workspaceFolder);
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
