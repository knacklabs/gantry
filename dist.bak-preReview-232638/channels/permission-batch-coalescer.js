import { decisionForMode as domainDecisionForMode } from '../domain/permission-decision.js';
import { PERMISSION_APPROVAL_TIMEOUT_MS } from '../shared/permission-timeout.js';
import { sha256Hex } from '../shared/stable-hash.js';
import { limitPermissionMessage } from './permission-text-sanitizer.js';
export const DEFAULT_PERMISSION_BATCH_WINDOW_MS = 1500;
export const PENDING_PERMISSION_BATCH_WINDOW_MS = 3000;
export function createPermissionBatchRequest(requests, rows) {
    const first = requests[0];
    if (!first)
        throw new Error('Permission batch requires at least one request');
    const requestIds = requests.map((request) => request.requestId);
    const requestSetHash = sha256Hex(JSON.stringify([...requestIds].sort()));
    const batch = {
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
    const rendered = formatPermissionBatchPromptText(batch, PERMISSION_APPROVAL_TIMEOUT_MS);
    if (rendered && limitPermissionMessage(rendered) !== rendered) {
        batch.decisionOptions = ['allow_persistent_rule', 'cancel'];
    }
    return batch;
}
export function permissionBatchRows(request) {
    return [...(request.permissionBatch?.rows ?? [])];
}
export function isPermissionBatchRequest(request) {
    return permissionBatchRows(request).length > 0;
}
export function decisionForPermissionInteraction(request, mode, decidedBy, matchKind) {
    if ((isPermissionBatchRequest(request) || matchKind === 'batch') &&
        mode === 'allow_persistent_rule') {
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
export function withRecoveredBatchOption(options, matchKind) {
    return matchKind === 'batch' && !options.includes('allow_persistent_rule')
        ? [
            ...options.filter((mode) => mode !== 'cancel'),
            'allow_persistent_rule',
            ...(options.includes('cancel') ? ['cancel'] : []),
        ]
        : options;
}
export function permissionBatchButtonLabel(request, mode) {
    if (!isPermissionBatchRequest(request))
        return undefined;
    if (mode === 'allow_once')
        return 'Allow all';
    if (mode === 'allow_persistent_rule')
        return 'Review each';
    return 'Deny all';
}
export function formatPermissionBatchPrompt(request, timeoutMs) {
    const rows = permissionBatchRows(request);
    if (rows.length === 0)
        return undefined;
    return {
        title: `Review ${rows.length} permission requests`,
        rows,
        replyInMinutes: Math.max(1, Math.round(timeoutMs / 60000)),
    };
}
export function formatPermissionBatchPromptText(request, timeoutMs) {
    const batch = formatPermissionBatchPrompt(request, timeoutMs);
    return batch
        ? [
            `🔐 ${batch.title}`,
            '',
            ...batch.rows,
            ...(timeoutMs > 0 ? ['', `Reply in ${batch.replyInMinutes}m`] : []),
        ].join('\n')
        : undefined;
}
export function buildPermissionBatchPromptParts(request, timeoutMs) {
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
export class PermissionBatchCoalescer {
    windowMs;
    setTimer;
    clearTimer;
    onFlush;
    pendingWindowMs;
    isPromptPending;
    pending = new Map();
    constructor(options = {}) {
        this.windowMs = options.windowMs ?? DEFAULT_PERMISSION_BATCH_WINDOW_MS;
        this.pendingWindowMs =
            options.pendingWindowMs ?? PENDING_PERMISSION_BATCH_WINDOW_MS;
        this.isPromptPending = options.isPromptPending;
        this.setTimer = options.setTimer ?? setTimeout;
        this.clearTimer = options.clearTimer ?? clearTimeout;
        this.onFlush = options.onFlush;
    }
    enqueue(request) {
        const key = permissionBatchKey(request);
        const existing = this.pending.get(key);
        if (existing) {
            existing.requests.push(request);
            return key;
        }
        const batch = {
            key,
            requests: [request],
            timer: this.setTimer(() => {
                this.flushKey(key, 'window_elapsed');
            }, this.isPromptPending?.(key, request)
                ? this.pendingWindowMs
                : this.windowMs),
        };
        this.pending.set(key, batch);
        return key;
    }
    flushKey(key, reason = 'manual') {
        const batch = this.pending.get(key);
        if (!batch)
            return undefined;
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
    flushAll(reason = 'manual') {
        return Array.from(this.pending.keys())
            .map((key) => this.flushKey(key, reason))
            .filter((batch) => Boolean(batch));
    }
    flushOnDecision(decision) {
        if (isDenyOrCancelDecision(decision)) {
            return this.flushAll('deny_or_cancel');
        }
        return [];
    }
    size() {
        return this.pending.size;
    }
    dispose() {
        for (const batch of this.pending.values()) {
            this.clearTimer(batch.timer);
        }
        this.pending.clear();
    }
}
export function permissionBatchKey(request) {
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
export function isDenyOrCancelDecision(decision) {
    return decision.approved !== true || decision.mode === 'cancel';
}
