import type {
  PermissionApprovalDecision,
  PermissionApprovalDecisionMode,
  PermissionApprovalRequest,
  PermissionCallbackClaim,
} from '../domain/types.js';
import { decisionForMode as domainDecisionForMode } from '../domain/permission-decision.js';
import { PERMISSION_APPROVAL_TIMEOUT_MS } from '../shared/permission-timeout.js';
import { sha256Hex } from '../shared/stable-hash.js';
import { limitPermissionMessage } from './permission-text-sanitizer.js';

export const DEFAULT_PERMISSION_BATCH_WINDOW_MS = 1500;
export const PENDING_PERMISSION_BATCH_WINDOW_MS = 3000;

export function createPermissionBatchRequest(
  requests: PermissionApprovalRequest[],
  rows: string[],
): PermissionApprovalRequest {
  const first = requests[0];
  if (!first) throw new Error('Permission batch requires at least one request');
  const requestIds = requests.map((request) => request.requestId);
  const requestSetHash = sha256Hex(JSON.stringify([...requestIds].sort()));
  const batch: PermissionApprovalRequest = {
    ...first,
    requestId: `batch:${first.requestId}:${requests.length}:${requestSetHash}`,
    title: `Review ${requests.length} permission requests`,
    displayName: undefined,
    interaction: undefined,
    suggestions: undefined,
    decisionOptions: ['allow_once', 'allow_persistent_rule', 'cancel'],
    toolInput: undefined,
    permissionBatch: {
      requestIds,
      rows: [...rows],
    },
  };
  const rendered = formatPermissionBatchPromptText(
    batch,
    PERMISSION_APPROVAL_TIMEOUT_MS,
  );
  if (rendered && limitPermissionMessage(rendered) !== rendered) {
    batch.decisionOptions = ['allow_persistent_rule', 'cancel'];
  }
  return batch;
}

export function permissionBatchRows(
  request: PermissionApprovalRequest,
): string[] {
  return [...(request.permissionBatch?.rows ?? [])];
}

export function isPermissionBatchRequest(
  request: PermissionApprovalRequest,
): boolean {
  return permissionBatchRows(request).length > 0;
}

export function decisionForPermissionInteraction(
  request: PermissionApprovalRequest,
  mode: PermissionApprovalDecisionMode,
  decidedBy?: string,
  matchKind?: PermissionCallbackClaim['match']['kind'],
): PermissionApprovalDecision {
  if (
    (isPermissionBatchRequest(request) || matchKind === 'batch') &&
    mode === 'allow_persistent_rule'
  ) {
    return {
      approved: true,
      mode,
      decidedBy,
      reason: 'review each',
      decisionClassification: 'user_temporary',
      batchDecision: 'review_each',
    };
  }
  return domainDecisionForMode(request, mode, decidedBy);
}

export function withRecoveredBatchOption(
  options: PermissionApprovalDecisionMode[],
  matchKind?: PermissionCallbackClaim['match']['kind'],
): PermissionApprovalDecisionMode[] {
  return matchKind === 'batch' && !options.includes('allow_persistent_rule')
    ? [
        ...options.filter((mode) => mode !== 'cancel'),
        'allow_persistent_rule',
        ...(options.includes('cancel') ? (['cancel'] as const) : []),
      ]
    : options;
}

export function permissionBatchButtonLabel(
  request: PermissionApprovalRequest,
  mode: PermissionApprovalDecisionMode,
): string | undefined {
  if (!isPermissionBatchRequest(request)) return undefined;
  if (mode === 'allow_once') return 'Allow all';
  if (mode === 'allow_persistent_rule') return 'Review each';
  return 'Deny all';
}

export function formatPermissionBatchPrompt(
  request: PermissionApprovalRequest,
  timeoutMs: number,
): { title: string; rows: string[]; replyInMinutes: number } | undefined {
  const rows = permissionBatchRows(request);
  if (rows.length === 0) return undefined;
  return {
    title: `Review ${rows.length} permission requests`,
    rows,
    replyInMinutes: Math.max(1, Math.round(timeoutMs / 60000)),
  };
}

export function formatPermissionBatchPromptText(
  request: PermissionApprovalRequest,
  timeoutMs: number,
): string | undefined {
  const batch = formatPermissionBatchPrompt(request, timeoutMs);
  return batch
    ? [
        `🔐 ${batch.title}`,
        '',
        ...batch.rows,
        '',
        `Reply in ${batch.replyInMinutes}m`,
      ].join('\n')
    : undefined;
}

export function buildPermissionBatchPromptParts(
  request: PermissionApprovalRequest,
  timeoutMs: number,
):
  | {
      title: string;
      bodyLines: string[];
      contextLines: string[];
      replyInMinutes: number;
    }
  | undefined {
  const batch = formatPermissionBatchPrompt(request, timeoutMs);
  return batch
    ? {
        title: batch.title,
        bodyLines: batch.rows,
        contextLines: [],
        replyInMinutes: batch.replyInMinutes,
      }
    : undefined;
}

export type PermissionBatchFlushReason =
  'window_elapsed' | 'manual' | 'deny_or_cancel';

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
  pendingWindowMs?: number;
  isPromptPending?: (
    key: string,
    request: PermissionApprovalRequest,
  ) => boolean;
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
  private readonly pendingWindowMs: number;
  private readonly isPromptPending?: (
    key: string,
    request: PermissionApprovalRequest,
  ) => boolean;
  private readonly pending = new Map<string, PendingPermissionBatch>();

  constructor(options: PermissionBatchCoalescerOptions = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_PERMISSION_BATCH_WINDOW_MS;
    this.pendingWindowMs =
      options.pendingWindowMs ?? PENDING_PERMISSION_BATCH_WINDOW_MS;
    this.isPromptPending = options.isPromptPending;
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
      timer: this.setTimer(
        () => {
          this.flushKey(key, 'window_elapsed');
        },
        this.isPromptPending?.(key, request)
          ? this.pendingWindowMs
          : this.windowMs,
      ),
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
    | 'appId'
    | 'sourceAgentFolder'
    | 'targetJid'
    | 'approvalContextJid'
    | 'runId'
    | 'decisionPolicy'
    | 'providerAccountId'
  >,
): string {
  // Topic/thread ids only route the prompt; approval batching follows the parent conversation.
  return JSON.stringify([
    request.appId || 'default',
    request.sourceAgentFolder,
    request.targetJid ?? '',
    request.approvalContextJid ?? '',
    request.runId ?? '',
    request.decisionPolicy ?? '',
    request.providerAccountId ?? '',
  ]);
}

export function isDenyOrCancelDecision(
  decision: PermissionApprovalDecision,
): boolean {
  return decision.approved !== true || decision.mode === 'cancel';
}
