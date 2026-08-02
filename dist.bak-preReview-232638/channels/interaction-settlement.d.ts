import type { PermissionApprovalCancellation, PermissionApprovalRequest, UserQuestionCancellation, UserQuestionRequest } from '../domain/types.js';
export declare const RUNNER_CANCELLED_PERMISSION_REASON = "Permission request cancelled by its runner.";
export declare const RUNNER_CANCELLED_QUESTION_REASON = "Question cancelled by its runner.";
export type InteractionCancellationResult = 'settled' | 'already_decided' | 'retryable' | 'not_found';
export declare function pendingPermissionAliasesForCancellation<Pending extends {
    request: Pick<PermissionApprovalRequest, 'requestId' | 'appId' | 'sourceAgentFolder'>;
}>(pendingByAlias: ReadonlyMap<string, Pending>, cancellation: PermissionApprovalCancellation): string[];
export declare function matchesQuestionCancellation(request: Pick<UserQuestionRequest, 'requestId' | 'appId' | 'sourceAgentFolder'>, cancellation: UserQuestionCancellation): boolean;
export declare function settlePendingQuestionCancellation(cancellation: UserQuestionCancellation): Promise<Exclude<InteractionCancellationResult, 'not_found'>>;
export declare function cancelMatchingPendingQuestions<Pending>(input: {
    pending: Iterable<Pending>;
    cancellation: UserQuestionCancellation;
    request: (pending: Pending) => Pick<UserQuestionRequest, 'requestId' | 'appId' | 'sourceAgentFolder'>;
    settle: (pending: Pending, reason: string) => Promise<void>;
}): Promise<InteractionCancellationResult>;
export declare function resolveInteractionSettlementDelayMs(input: {
    expiresAt?: unknown;
    permissionLane?: 'interactive' | 'autonomous';
    fallbackTimeoutMs?: number;
}): number | undefined;
