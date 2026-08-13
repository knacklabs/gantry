import type {
  PermissionApprovalCancellation,
  PermissionApprovalDecision,
  PermissionApprovalRequest,
  PermissionApprovalResult,
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
  ) => Promise<PermissionApprovalResult>;
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
  /**
   * Reports delivery to the first caller for a request scope. Replays that
   * coalesce onto the same pending request share its decision but do not
   * receive a second delivery callback for the same provider prompt.
   */
  (
    request: PermissionApprovalRequest,
    onPromptDelivered?: (messageId: string) => void,
  ): Promise<PermissionApprovalResult>;
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
  const pendingResolvers = new Map<
    string,
    {
      promise: Promise<PermissionApprovalResult>;
      resolve: (result: PermissionApprovalResult) => void;
      reject: (reason?: unknown) => void;
      onPromptDelivered?: (messageId: string) => void;
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
    onPromptDelivered?: (messageId: string) => void,
  ): Promise<PermissionApprovalResult> {
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
        kind: 'decision',
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
      return {
        kind: 'delivery_failure',
        code: 'target_missing',
        retryable: true,
        delivered: 'no',
        userMessage: routed.blockedReason,
      };
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
        kind: 'delivery_failure',
        code: 'surface_unsupported',
        retryable: true,
        delivered: 'no',
        userMessage: 'Target channel does not support permission approvals',
      };
    }
    try {
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
      let result: PermissionApprovalResult;
      try {
        result = await approvalSurface.requestPermissionApproval(
          routed.targetJid,
          routed.request,
          (messageId) => {
            onPromptDelivered?.(messageId);
            input.interactionLifecycle.resetStreaming?.(routed.targetJid, {
              providerAccountId: routed.request.providerAccountId,
              threadId: routed.request.threadId,
            });
            for (const key of cancellationKeys) {
              const cancellation = queuedCancellations.get(key);
              if (cancellation) {
                void settleQueuedCancellationSafely(cancellation);
              }
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
        result = {
          kind: 'decision',
          decision: {
            approved: false,
            mode: 'cancel',
            decidedBy: 'runtime',
            reason: cancellation.reason,
            decisionClassification: 'user_reject',
          },
        };
        clearQueuedCancellation(requestKey);
      }
      return result;
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
      return {
        kind: 'delivery_failure',
        code: 'provider_failed',
        retryable: false,
        delivered: 'unknown',
        userMessage: 'Permission approval flow failed',
      };
    }
  }

  async function settleQueuedCancellation(
    cancellation: PermissionApprovalCancellation,
  ): Promise<'settled' | 'queued'> {
    const key = permissionRequestScopeKey(cancellation);
    const cancel = activeCancellationHandlers.get(key);
    if (!cancel) return 'queued';
    const result = await cancel(cancellation);
    if (result === 'settled' || result === 'already_decided') {
      clearQueuedCancellation(key);
      return 'settled';
    }
    // The durable IPC directory owns retries; a local timer can race it and cannot survive restart.
    return 'queued';
  }

  async function settleQueuedCancellationSafely(
    cancellation: PermissionApprovalCancellation,
  ): Promise<'settled' | 'queued'> {
    const key = permissionRequestScopeKey(cancellation);
    const targetJid = activeCancellationTargets.get(key);
    try {
      return await settleQueuedCancellation(cancellation);
    } catch (err) {
      input.interactionLifecycle.logger.error({
        err,
        targetJid,
        requestId: cancellation.requestId,
        message: 'Target channel permission cancellation failed',
      });
      return 'queued';
    }
  }

  function clearQueuedCancellation(key: string): void {
    queuedCancellations.delete(key);
  }

  async function dispatchBatch(batch: PermissionBatch): Promise<void> {
    const activePrompt = batch.requests[0];
    let batchDecision: PermissionApprovalDecision | null = null;
    let batchClaimSettled = false;
    if (activePrompt) activePrompts.add(activePrompt);
    try {
      if (batch.requests.length === 1) {
        const result = await dispatchSingle(
          batch.requests[0],
          [],
          promptDeliveredCallback(batch.requests),
        );
        if (
          !resolveBatchRequest(batch.requests[0], result) &&
          result.kind === 'decision'
        ) {
          await releaseDecisionClaim(result.decision);
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
      const batchResult = await dispatchSingle(
        batchRequest,
        batch.requests,
        promptDeliveredCallback(batch.requests),
      );
      if (batchResult.kind === 'delivery_failure') {
        for (const request of batch.requests) {
          resolveBatchRequest(request, batchResult);
        }
        return;
      }
      batchDecision = batchResult.decision;
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
          const result = await dispatchSingle(request);
          if (
            !resolveBatchRequest(request, result) &&
            result.kind === 'decision'
          ) {
            await releaseDecisionClaim(result.decision);
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
        const resolved = resolveBatchRequest(request, {
          kind: 'decision',
          decision: batchDecision.permissionCallbackClaim
            ? {
                ...derivedDecision,
                permissionCallbackClaim: batchDecision.permissionCallbackClaim,
              }
            : derivedDecision,
        });
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

  function promptDeliveredCallback(
    requests: readonly PermissionApprovalRequest[],
  ): ((messageId: string) => void) | undefined {
    const callbacks = [
      ...new Map(
        requests.flatMap((request) => {
          const callback = pendingResolvers.get(
            permissionRequestScopeKey(request),
          )?.onPromptDelivered;
          return callback
            ? [[permissionRequestScopeKey(request), callback] as const]
            : [];
        }),
      ).values(),
    ];
    if (callbacks.length === 0) return undefined;
    let delivered = false;
    return (messageId) => {
      if (delivered) return;
      delivered = true;
      for (const callback of callbacks) callback(messageId);
    };
  }

  function resolveIncompleteBatch(requests: PermissionApprovalRequest[]): void {
    for (const request of requests) {
      resolveBatchRequest(request, {
        kind: 'delivery_failure',
        code: 'provider_failed',
        retryable: false,
        delivered: 'unknown',
        userMessage: 'Permission batch dispatch failed',
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
    result: PermissionApprovalResult,
  ): boolean {
    const key = permissionRequestScopeKey(request);
    const pending = pendingResolvers.get(key);
    if (!pending) return false;
    pendingResolvers.delete(key);
    pending.resolve(result);
    return true;
  }

  const requestPermissionApproval: PermissionApprovalRequester = (
    request,
    onPromptDelivered,
  ) => {
    if (!request.runId) {
      return dispatchSingle(request, [], onPromptDelivered);
    }
    const key = permissionRequestScopeKey(request);
    const existing = pendingResolvers.get(key);
    if (existing) return existing.promise;
    let resolvePending!: (result: PermissionApprovalResult) => void;
    let rejectPending!: (reason?: unknown) => void;
    const promise = new Promise<PermissionApprovalResult>((resolve, reject) => {
      resolvePending = resolve;
      rejectPending = reject;
    });
    pendingResolvers.set(key, {
      promise,
      resolve: resolvePending,
      reject: rejectPending,
      ...(onPromptDelivered ? { onPromptDelivered } : {}),
    });
    coalescer.enqueue(request);
    return promise;
  };
  requestPermissionApproval.cancel = async (cancellation) => {
    const key = permissionRequestScopeKey(cancellation);
    queuedCancellations.set(key, cancellation);
    const cancel = activeCancellationHandlers.get(key);
    if (!cancel) return 'queued';
    return settleQueuedCancellationSafely(cancellation);
  };
  return requestPermissionApproval;
}
