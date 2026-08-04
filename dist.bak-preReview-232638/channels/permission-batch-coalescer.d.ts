import type { PermissionApprovalDecision, PermissionApprovalDecisionMode, PermissionApprovalRequest, PermissionCallbackClaim } from '../domain/types.js';
export declare const DEFAULT_PERMISSION_BATCH_WINDOW_MS = 1500;
export declare const PENDING_PERMISSION_BATCH_WINDOW_MS = 3000;
export declare function createPermissionBatchRequest(requests: PermissionApprovalRequest[], rows: string[]): PermissionApprovalRequest;
export declare function permissionBatchRows(request: PermissionApprovalRequest): string[];
export declare function isPermissionBatchRequest(request: PermissionApprovalRequest): boolean;
export declare function decisionForPermissionInteraction(request: PermissionApprovalRequest, mode: PermissionApprovalDecisionMode, decidedBy?: string, matchKind?: PermissionCallbackClaim['match']['kind']): PermissionApprovalDecision;
export declare function withRecoveredBatchOption(options: PermissionApprovalDecisionMode[], matchKind?: PermissionCallbackClaim['match']['kind']): PermissionApprovalDecisionMode[];
export declare function permissionBatchButtonLabel(request: PermissionApprovalRequest, mode: PermissionApprovalDecisionMode): string | undefined;
export declare function formatPermissionBatchPrompt(request: PermissionApprovalRequest, timeoutMs: number): {
    title: string;
    rows: string[];
    replyInMinutes: number;
} | undefined;
export declare function formatPermissionBatchPromptText(request: PermissionApprovalRequest, timeoutMs: number): string | undefined;
export declare function buildPermissionBatchPromptParts(request: PermissionApprovalRequest, timeoutMs: number): {
    title: string;
    bodyLines: string[];
    contextLines: string[];
    replyInMinutes: number;
} | undefined;
export type PermissionBatchFlushReason = 'window_elapsed' | 'manual' | 'deny_or_cancel';
export interface PermissionBatch {
    key: string;
    requests: PermissionApprovalRequest[];
    reason: PermissionBatchFlushReason;
}
export interface PermissionBatchCoalescerOptions {
    windowMs?: number;
    pendingWindowMs?: number;
    isPromptPending?: (key: string, request: PermissionApprovalRequest) => boolean;
    setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
    onFlush?: (batch: PermissionBatch) => void;
}
export declare class PermissionBatchCoalescer {
    private readonly windowMs;
    private readonly setTimer;
    private readonly clearTimer;
    private readonly onFlush?;
    private readonly pendingWindowMs;
    private readonly isPromptPending?;
    private readonly pending;
    constructor(options?: PermissionBatchCoalescerOptions);
    enqueue(request: PermissionApprovalRequest): string;
    flushKey(key: string, reason?: PermissionBatchFlushReason): PermissionBatch | undefined;
    flushAll(reason?: PermissionBatchFlushReason): PermissionBatch[];
    flushOnDecision(decision: PermissionApprovalDecision): PermissionBatch[];
    size(): number;
    dispose(): void;
}
export declare function permissionBatchKey(request: Pick<PermissionApprovalRequest, 'appId' | 'sourceAgentFolder' | 'targetJid' | 'approvalContextJid' | 'runId' | 'decisionPolicy' | 'providerAccountId'>): string;
export declare function isDenyOrCancelDecision(decision: PermissionApprovalDecision): boolean;
