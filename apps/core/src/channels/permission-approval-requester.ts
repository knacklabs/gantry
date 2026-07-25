import type {
  PermissionApprovalCancellation,
  PermissionApprovalDecision,
  PermissionApprovalRequest,
} from '../domain/types.js';
import {
  DurableInteractionPersistenceError,
  releasePermissionInteractionCallback,
  settlePermissionInteractionCallback,
} from '../application/interactions/pending-interaction-durability.js';
import {
  PermissionBatchCoalescer,
  createPermissionBatchRequest,
  type PermissionBatch,
} from './permission-batch-coalescer.js';
import { decisionForMode } from './permission-interaction.js';
import { formatStructuredPermissionReceiptActionSummary } from './permission-receipt-action-summary.js';

type ChannelLike = object;

interface PermissionApprovalSurfaceLike {
  requestPermissionApproval: (
    targetJid: string,
    request: PermissionApprovalRequest,
    onPromptDelivered?: (messageId: string) => void,
  ) => Promise<PermissionApprovalDecision>;
  dropPendingInteraction?: (
    kind: 'permission' | 'question',
    request: PermissionApprovalRequest,
  ) => void;
  cancelPendingPermission?: (
    request: PermissionApprovalCancellation,
  ) => Promise<'settled' | 'already_decided' | 'retryable' | 'not_found'>;
}

interface PermissionApprovalTargetResolution {
  targetJid: string;
  request: PermissionApprovalRequest;
}

interface PermissionApprovalTargetBlocked {
  blockedReason: string;
}

const permissionRequestScopeKey = (
  request: Pick<
    PermissionApprovalRequest,
    'appId' | 'sourceAgentFolder' | 'requestId'
  >,
): string =>
  JSON.stringify([
    request.appId || 'default',
    request.sourceAgentFolder,
    request.requestId,
  ]);

export interface PermissionApprovalRequester {
  (request: PermissionApprovalRequest): Promise<PermissionApprovalDecision>;
  cancel(
    cancellation: PermissionApprovalCancellation,
  ): Promise<'settled' | 'queued' | 'not_found'>;
}

function resolvePermissionApprovalTarget(
  request: PermissionApprovalRequest,
): PermissionApprovalTargetResolution | PermissionApprovalTargetBlocked {
  return request.targetJid
    ? { targetJid: request.targetJid, request }
    : { blockedReason: 'Permission approval target is missing' };
}

export function createPermissionApprovalRequester(input: {
  findBoundChannel: (
    jid: string,
    providerAccountId?: string,
    request?: PermissionApprovalRequest,
  ) => ChannelLike | undefined;
  asPermissionApprovalSurface: (
    channel: ChannelLike,
  ) => PermissionApprovalSurfaceLike | undefined;
  interactionLifecycle: {
    logger: {
      error: (
        dataOrMsg: string | Record<string, unknown>,
        msg?: string,
      ) => void;
    };
    resetStreaming?: (
      jid: string,
      options?: { providerAccountId?: string; threadId?: string },
    ) => void;
  };
}): PermissionApprovalRequester {
  const activePrompts = new Set<PermissionApprovalRequest>();
  const queuedCancellations = new Map<string, PermissionApprovalCancellation>();
  const activeCancellationHandlers = new Map<
    string,
    (
      cancellation: PermissionApprovalCancellation,
    ) => Promise<'settled' | 'already_decided' | 'retryable' | 'not_found'>
  >();
  const activeCancellationTargets = new Map<string, string>();
  const cancellationRetryTimers = new Map<string, NodeJS.Timeout>();
  const pendingResolvers = new Map<
    string,
    {
      promise: Promise<PermissionApprovalDecision>;
      resolve: (decision: PermissionApprovalDecision) => void;
      reject: (reason?: unknown) => void;
    }
  >();
  const coalescer = new PermissionBatchCoalescer({
    isPromptPending: (_key, request) =>
      Array.from(activePrompts).some(
        (active) =>
          active.targetJid === request.targetJid &&
          active.providerAccountId === request.providerAccountId,
      ),
    onFlush: (batch) => void dispatchBatch(batch),
  });

  async function releaseDecisionClaim(
    decision: PermissionApprovalDecision | null | undefined,
  ): Promise<void> {
    if (!decision?.permissionCallbackClaim) return;
    const released = await releasePermissionInteractionCallback({
      claim: decision.permissionCallbackClaim,
    });
    if (!released) {
      input.interactionLifecycle.logger.error({
        claimId: decision.permissionCallbackClaim.id,
        message: 'Failed to release permission callback claim',
      });
    }
  }

  async function dispatchSingle(
    request: PermissionApprovalRequest,
    cancellationAliases: PermissionApprovalRequest[] = [],
  ): Promise<PermissionApprovalDecision> {
    const result = await dispatchSingleResult(request, cancellationAliases);
    return result.delivered
      ? result.decision
      : { approved: false, reason: result.reason };
  }

  async function dispatchSingleResult(
    request: PermissionApprovalRequest,
    cancellationAliases: PermissionApprovalRequest[] = [],
  ): Promise<
    | { delivered: true; decision: PermissionApprovalDecision }
    | { delivered: false; reason: string }
  > {
    const requestKey = permissionRequestScopeKey(request);
    const cancellationKeys = [
      requestKey,
      ...cancellationAliases.map(permissionRequestScopeKey),
    ].filter((key, index, keys) => keys.indexOf(key) === index);
    const queuedCancellationKey = cancellationKeys.find((key) =>
      queuedCancellations.has(key),
    );
    const queuedCancellation = queuedCancellationKey
      ? queuedCancellations.get(queuedCancellationKey)
      : undefined;
    if (queuedCancellation) {
      clearQueuedCancellation(queuedCancellationKey!);
      return {
        delivered: true,
        decision: {
          approved: false,
          mode: 'cancel',
          decidedBy: 'runtime',
          reason: queuedCancellation.reason,
          decisionClassification: 'user_reject',
        },
      };
    }
    const routed = resolvePermissionApprovalTarget(request);
    if ('blockedReason' in routed) {
      return { delivered: false, reason: routed.blockedReason };
    }
    const channel = input.findBoundChannel(
      routed.targetJid,
      request.providerAccountId,
      request,
    );
    const approvalSurface = channel
      ? input.asPermissionApprovalSurface(channel)
      : undefined;
    if (!approvalSurface) {
      return {
        delivered: false,
        reason: 'Target channel does not support permission approvals',
      };
    }
    try {
      let promptDelivered = false;
      const cancelPending = (
        cancellation: PermissionApprovalCancellation,
      ): Promise<'settled' | 'already_decided' | 'retryable' | 'not_found'> =>
        approvalSurface.cancelPendingPermission?.(cancellation) ??
        Promise.resolve('not_found');
      for (const key of cancellationKeys) {
        activeCancellationHandlers.set(key, (cancellation) =>
          cancelPending({ ...cancellation, requestId: request.requestId }),
        );
        activeCancellationTargets.set(key, routed.targetJid);
      }
      let decision: PermissionApprovalDecision;
      try {
        decision = await approvalSurface.requestPermissionApproval(
          routed.targetJid,
          routed.request,
          () => {
            promptDelivered = true;
            input.interactionLifecycle.resetStreaming?.(routed.targetJid, {
              providerAccountId: routed.request.providerAccountId,
              threadId: routed.request.threadId,
            });
            for (const key of cancellationKeys) {
              const cancellation = queuedCancellations.get(key);
              if (cancellation) settleQueuedCancellationSafely(cancellation);
            }
          },
        );
      } finally {
        for (const key of cancellationKeys) {
          activeCancellationHandlers.delete(key);
          activeCancellationTargets.delete(key);
        }
      }
      const cancellation = cancellationAliases.length
        ? undefined
        : queuedCancellations.get(requestKey);
      if (cancellation) {
        decision = {
          approved: false,
          mode: 'cancel',
          decidedBy: 'runtime',
          reason: cancellation.reason,
          decisionClassification: 'user_reject',
        };
        clearQueuedCancellation(requestKey);
      }
      return promptDelivered
        ? { delivered: true, decision }
        : {
            delivered: false,
            reason:
              decision.reason || 'Permission approval prompt was not delivered',
          };
    } catch (err) {
      input.interactionLifecycle.logger.error({
        err,
        targetJid: routed.targetJid,
        requestId: request.requestId,
        message: 'Target channel permission approval flow failed',
      });
      if (err instanceof DurableInteractionPersistenceError) {
        approvalSurface.dropPendingInteraction?.('permission', routed.request);
        throw err;
      }
      return { delivered: false, reason: 'Permission approval flow failed' };
    }
  }

  async function settleQueuedCancellation(
    cancellation: PermissionApprovalCancellation,
  ): Promise<void> {
    const key = permissionRequestScopeKey(cancellation);
    const cancel = activeCancellationHandlers.get(key);
    if (!cancel) return;
    const result = await cancel(cancellation);
    if (result === 'settled' || result === 'already_decided') {
      clearQueuedCancellation(key);
      return;
    }
    if (result === 'retryable') scheduleCancellationRetry(cancellation);
  }

  function settleQueuedCancellationSafely(
    cancellation: PermissionApprovalCancellation,
  ): void {
    const key = permissionRequestScopeKey(cancellation);
    const targetJid = activeCancellationTargets.get(key);
    void settleQueuedCancellation(cancellation).catch((err) => {
      input.interactionLifecycle.logger.error({
        err,
        targetJid,
        requestId: cancellation.requestId,
        message: 'Target channel permission cancellation failed',
      });
      scheduleCancellationRetry(cancellation);
    });
  }

  function scheduleCancellationRetry(
    cancellation: PermissionApprovalCancellation,
  ): void {
    const key = permissionRequestScopeKey(cancellation);
    if (cancellationRetryTimers.has(key)) return;
    const timer = setTimeout(() => {
      cancellationRetryTimers.delete(key);
      settleQueuedCancellationSafely(cancellation);
    }, 250);
    timer.unref?.();
    cancellationRetryTimers.set(key, timer);
  }

  function clearQueuedCancellation(key: string): void {
    queuedCancellations.delete(key);
    const retryTimer = cancellationRetryTimers.get(key);
    if (retryTimer) clearTimeout(retryTimer);
    cancellationRetryTimers.delete(key);
  }

  async function dispatchBatch(batch: PermissionBatch): Promise<void> {
    const activePrompt = batch.requests[0];
    let batchDecision: PermissionApprovalDecision | null = null;
    let batchClaimSettled = false;
    if (activePrompt) activePrompts.add(activePrompt);
    try {
      if (batch.requests.length === 1) {
        const decision = await dispatchSingle(batch.requests[0]);
        if (!resolveBatchRequest(batch.requests[0], decision)) {
          await releaseDecisionClaim(decision);
        }
        return;
      }
      const summaries = batch.requests.map((request) =>
        formatStructuredPermissionReceiptActionSummary(request),
      );
      const batchRequest = createPermissionBatchRequest(
        batch.requests,
        summaries.map((summary, index) => `${index + 1}. ${summary.text}`),
      );
      if (!summaries.every((summary) => summary.bulkEligible)) {
        batchRequest.decisionOptions = ['allow_persistent_rule', 'cancel'];
      }
      batchDecision = await dispatchSingle(batchRequest, batch.requests);
      if (!batch.requests.every(hasBatchResolver)) {
        await releaseDecisionClaim(batchDecision);
        resolveIncompleteBatch(batch.requests);
        return;
      }
      if (
        batchDecision.approved &&
        batchDecision.mode === 'allow_persistent_rule' &&
        batchDecision.batchDecision === 'review_each'
      ) {
        if (
          batchDecision.permissionCallbackClaim &&
          !(await settlePermissionInteractionCallback({
            claim: batchDecision.permissionCallbackClaim,
          }))
        ) {
          await releaseDecisionClaim(batchDecision);
          resolveIncompleteBatch(batch.requests);
          return;
        }
        batchClaimSettled = Boolean(batchDecision.permissionCallbackClaim);
        for (const request of batch.requests) {
          const decision = await dispatchSingle(request);
          if (!resolveBatchRequest(request, decision)) {
            await releaseDecisionClaim(decision);
          }
        }
        return;
      }
      let fanOutComplete = true;
      for (const request of batch.requests) {
        const key = permissionRequestScopeKey(request);
        const cancellation = queuedCancellations.get(key);
        const derivedDecision = cancellation
          ? {
              approved: false,
              mode: 'cancel' as const,
              decidedBy: 'runtime',
              reason: cancellation.reason,
              decisionClassification: 'user_reject' as const,
            }
          : decisionForMode(
              request,
              batchDecision.approved ? 'allow_once' : 'cancel',
              batchDecision.decidedBy,
            );
        const resolved = resolveBatchRequest(
          request,
          batchDecision.permissionCallbackClaim
            ? {
                ...derivedDecision,
                permissionCallbackClaim: batchDecision.permissionCallbackClaim,
              }
            : derivedDecision,
        );
        if (resolved && cancellation) clearQueuedCancellation(key);
        fanOutComplete = resolved && fanOutComplete;
      }
      if (!fanOutComplete) {
        await releaseDecisionClaim(batchDecision);
        resolveIncompleteBatch(batch.requests);
      }
    } catch (err) {
      if (!batchClaimSettled) await releaseDecisionClaim(batchDecision);
      input.interactionLifecycle.logger.error({
        err,
        batchKey: batch.key,
        message: 'Permission batch fan-out failed',
      });
      if (err instanceof DurableInteractionPersistenceError) {
        rejectIncompleteBatch(batch.requests, err);
        return;
      }
      resolveIncompleteBatch(batch.requests);
    } finally {
      if (activePrompt) activePrompts.delete(activePrompt);
    }
  }

  function hasBatchResolver(request: PermissionApprovalRequest): boolean {
    return pendingResolvers.has(permissionRequestScopeKey(request));
  }

  function resolveIncompleteBatch(requests: PermissionApprovalRequest[]): void {
    for (const request of requests) {
      resolveBatchRequest(request, {
        approved: false,
        reason: 'Permission batch dispatch failed',
      });
    }
  }

  function rejectIncompleteBatch(
    requests: PermissionApprovalRequest[],
    reason: unknown,
  ): void {
    for (const request of requests) {
      const key = permissionRequestScopeKey(request);
      const pending = pendingResolvers.get(key);
      if (!pending) continue;
      pendingResolvers.delete(key);
      pending.reject(reason);
    }
  }

  function resolveBatchRequest(
    request: PermissionApprovalRequest,
    decision: PermissionApprovalDecision,
  ): boolean {
    const key = permissionRequestScopeKey(request);
    const pending = pendingResolvers.get(key);
    if (!pending) return false;
    pendingResolvers.delete(key);
    pending.resolve(decision);
    return true;
  }

  const requestPermissionApproval: PermissionApprovalRequester = (request) => {
    if (!request.runId) return dispatchSingle(request);
    const key = permissionRequestScopeKey(request);
    const existing = pendingResolvers.get(key);
    if (existing) return existing.promise;
    let resolvePending!: (decision: PermissionApprovalDecision) => void;
    let rejectPending!: (reason?: unknown) => void;
    const promise = new Promise<PermissionApprovalDecision>(
      (resolve, reject) => {
        resolvePending = resolve;
        rejectPending = reject;
      },
    );
    pendingResolvers.set(key, {
      promise,
      resolve: resolvePending,
      reject: rejectPending,
    });
    coalescer.enqueue(request);
    return promise;
  };
  requestPermissionApproval.cancel = async (cancellation) => {
    const key = permissionRequestScopeKey(cancellation);
    queuedCancellations.set(key, cancellation);
    const cancel = activeCancellationHandlers.get(key);
    if (!cancel) return 'queued';
    const result = await cancel(cancellation);
    if (result === 'settled' || result === 'already_decided') {
      clearQueuedCancellation(key);
      return 'settled';
    }
    if (result === 'retryable') scheduleCancellationRetry(cancellation);
    return 'queued';
  };
  return requestPermissionApproval;
}
