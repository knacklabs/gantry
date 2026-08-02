import { getPermissionTimeoutMs, NO_PERMISSION_TIMEOUT_MS, } from '../shared/permission-timeout.js';
import { resolvePendingInteractionRecordOutcome } from '../application/interactions/pending-interaction-durability.js';
export const RUNNER_CANCELLED_PERMISSION_REASON = 'Permission request cancelled by its runner.';
export const RUNNER_CANCELLED_QUESTION_REASON = 'Question cancelled by its runner.';
export function pendingPermissionAliasesForCancellation(pendingByAlias, cancellation) {
    const appId = cancellation.appId || 'default';
    return [...pendingByAlias]
        .filter(([, pending]) => pending.request.requestId === cancellation.requestId &&
        pending.request.sourceAgentFolder === cancellation.sourceAgentFolder &&
        (pending.request.appId || 'default') === appId)
        .map(([providerAlias]) => providerAlias);
}
export function matchesQuestionCancellation(request, cancellation) {
    return (request.requestId === cancellation.requestId &&
        request.sourceAgentFolder === cancellation.sourceAgentFolder &&
        (request.appId || 'default') === (cancellation.appId || 'default'));
}
export async function settlePendingQuestionCancellation(cancellation) {
    const outcome = await resolvePendingInteractionRecordOutcome({
        kind: 'question',
        sourceAgentFolder: cancellation.sourceAgentFolder,
        requestId: cancellation.requestId,
        appId: cancellation.appId,
        status: 'cancelled',
        resolution: {
            answers: {},
            reason: cancellation.reason ?? RUNNER_CANCELLED_QUESTION_REASON,
        },
        approverRef: null,
    });
    if (outcome === 'resolved')
        return 'settled';
    if (outcome === 'retryable_error')
        return 'retryable';
    return 'already_decided';
}
export async function cancelMatchingPendingQuestions(input) {
    const pendingQuestions = [...new Set(input.pending)].filter((pending) => matchesQuestionCancellation(input.request(pending), input.cancellation));
    if (pendingQuestions.length === 0)
        return 'not_found';
    const settled = await settlePendingQuestionCancellation(input.cancellation);
    if (settled !== 'settled')
        return settled;
    const reason = input.cancellation.reason ?? RUNNER_CANCELLED_QUESTION_REASON;
    await Promise.all(pendingQuestions.map((pending) => input.settle(pending, reason)));
    return 'settled';
}
export function resolveInteractionSettlementDelayMs(input) {
    const expiresAtMs = typeof input.expiresAt === 'string'
        ? Date.parse(input.expiresAt)
        : Number.NaN;
    if (Number.isFinite(expiresAtMs)) {
        return Math.max(0, expiresAtMs - Date.now());
    }
    if (input.permissionLane) {
        const timeoutMs = getPermissionTimeoutMs(input.permissionLane);
        return timeoutMs > NO_PERMISSION_TIMEOUT_MS ? timeoutMs : undefined;
    }
    if (input.fallbackTimeoutMs !== undefined &&
        input.fallbackTimeoutMs > NO_PERMISSION_TIMEOUT_MS) {
        return input.fallbackTimeoutMs;
    }
    return undefined;
}
