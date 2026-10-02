import type {
  PermissionApprovalCancellation,
  PermissionApprovalRequest,
  PermissionApprovalResult,
} from '../domain/types.js';
import { DurableInteractionPersistenceError } from '../application/interactions/pending-interaction-durability.js';

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
   * Every ask is its own prompt, answered on its own. Replays of the same
   * pending request share its decision but do not receive a second delivery
   * callback for the same provider prompt.
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
  const queuedCancellations = new Map<string, PermissionApprovalCancellation>();
  const activeCancellationHandlers = new Map<
    string,
    (
      cancellation: PermissionApprovalCancellation,
    ) => Promise<'settled' | 'already_decided' | 'retryable' | 'not_found'>
  >();
  const activeCancellationTargets = new Map<string, string>();
  const pendingRequests = new Map<string, Promise<PermissionApprovalResult>>();

  async function dispatchSingle(
    request: PermissionApprovalRequest,
    onPromptDelivered?: (messageId: string) => void,
  ): Promise<PermissionApprovalResult> {
    const requestKey = permissionRequestScopeKey(request);
    const queuedCancellation = queuedCancellations.get(requestKey);
    if (queuedCancellation) {
      clearQueuedCancellation(requestKey);
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
      activeCancellationHandlers.set(requestKey, (cancellation) =>
        cancelPending({ ...cancellation, requestId: request.requestId }),
      );
      activeCancellationTargets.set(requestKey, routed.targetJid);
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
            const cancellation = queuedCancellations.get(requestKey);
            if (cancellation) {
              void settleQueuedCancellationSafely(cancellation);
            }
          },
        );
      } finally {
        activeCancellationHandlers.delete(requestKey);
        activeCancellationTargets.delete(requestKey);
      }
      const cancellation = queuedCancellations.get(requestKey);
      // Only a real decision may be replaced by the queued cancellation: a
      // post-transmission delivery_failure must stay a delivery failure -
      // synthesizing a user_reject here would settle a durable row whose
      // card may still be live (transmission-boundary rule, 0128).
      if (cancellation && result.kind === 'decision') {
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
        // Deliberately NOT a delivery_failure: this is OUR durable row
        // failing, not the provider call - there is no durable interaction
        // a tap could resolve, so the request is dropped and the rejection
        // propagates to the durable IPC lane, which owns the retry
        // (D-0046 tracks the record-before-delivery crash window).
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

  const requestPermissionApproval: PermissionApprovalRequester = (
    request,
    onPromptDelivered,
  ) => {
    if (!request.runId) return dispatchSingle(request, onPromptDelivered);
    const key = permissionRequestScopeKey(request);
    const existing = pendingRequests.get(key);
    if (existing) return existing;
    const promise = dispatchSingle(request, onPromptDelivered).finally(() =>
      pendingRequests.delete(key),
    );
    pendingRequests.set(key, promise);
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
