import type {
  PermissionApprovalDecision,
  PermissionApprovalRequest,
} from '../domain/types.js';

export const DEFAULT_PERMISSION_BATCH_WINDOW_MS = 1500;

export type PermissionBatchFlushReason =
  | 'window_elapsed'
  | 'manual'
  | 'deny_or_cancel';

export interface PermissionBatch {
  key: string;
  requests: PermissionApprovalRequest[];
  reason: PermissionBatchFlushReason;
}

interface PendingPermissionBatch {
  key: string;
  requests: PermissionApprovalRequest[];
  timer: ReturnType<typeof setTimeout>;
}

export interface PermissionBatchCoalescerOptions {
  windowMs?: number;
  setTimer?: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  onFlush?: (batch: PermissionBatch) => void;
}

export class PermissionBatchCoalescer {
  private readonly windowMs: number;
  private readonly setTimer: (
    callback: () => void,
    delayMs: number,
  ) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  private readonly onFlush?: (batch: PermissionBatch) => void;
  private readonly pending = new Map<string, PendingPermissionBatch>();

  constructor(options: PermissionBatchCoalescerOptions = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_PERMISSION_BATCH_WINDOW_MS;
    this.setTimer = options.setTimer ?? setTimeout;
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.onFlush = options.onFlush;
  }

  enqueue(request: PermissionApprovalRequest): string {
    const key = permissionBatchKey(request);
    const existing = this.pending.get(key);
    if (existing) {
      existing.requests.push(request);
      return key;
    }

    const batch: PendingPermissionBatch = {
      key,
      requests: [request],
      timer: this.setTimer(() => {
        this.flushKey(key, 'window_elapsed');
      }, this.windowMs),
    };
    this.pending.set(key, batch);
    return key;
  }

  flushKey(
    key: string,
    reason: PermissionBatchFlushReason = 'manual',
  ): PermissionBatch | undefined {
    const batch = this.pending.get(key);
    if (!batch) return undefined;
    this.pending.delete(key);
    this.clearTimer(batch.timer);
    const flushed = {
      key,
      requests: [...batch.requests],
      reason,
    };
    this.onFlush?.(flushed);
    return flushed;
  }

  flushAll(reason: PermissionBatchFlushReason = 'manual'): PermissionBatch[] {
    return Array.from(this.pending.keys())
      .map((key) => this.flushKey(key, reason))
      .filter((batch): batch is PermissionBatch => Boolean(batch));
  }

  flushOnDecision(decision: PermissionApprovalDecision): PermissionBatch[] {
    if (isDenyOrCancelDecision(decision)) {
      return this.flushAll('deny_or_cancel');
    }
    return [];
  }

  size(): number {
    return this.pending.size;
  }

  dispose(): void {
    for (const batch of this.pending.values()) {
      this.clearTimer(batch.timer);
    }
    this.pending.clear();
  }
}

export function permissionBatchKey(
  request: Pick<
    PermissionApprovalRequest,
    'sourceAgentFolder' | 'targetJid' | 'threadId' | 'runId' | 'decisionPolicy'
  >,
): string {
  return JSON.stringify([
    request.sourceAgentFolder,
    request.targetJid ?? '',
    request.threadId ?? '',
    request.runId ?? '',
    request.decisionPolicy ?? '',
  ]);
}

export function isDenyOrCancelDecision(
  decision: PermissionApprovalDecision,
): boolean {
  return decision.approved !== true || decision.mode === 'cancel';
}
