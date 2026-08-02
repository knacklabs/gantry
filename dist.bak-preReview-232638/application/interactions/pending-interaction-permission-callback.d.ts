import type { PendingInteractionRepository } from '../../domain/ports/worker-coordination.js';
import type { PermissionApprovalDecision, PermissionApprovalDecisionMode, PermissionApprovalRequest, PermissionCallbackClaim, PermissionCallbackClaimReference, PermissionCallbackScope } from '../../domain/types.js';
import type { PermissionInteractionDecisionInput } from './pending-interaction-grants.js';
import type { PendingInteractionResolutionOutcome } from './pending-interaction-resolution.js';
import { type DurablePermissionFullView } from './pending-interaction-permission-envelope.js';
interface PermissionCallbackResolutionInput {
    kind: 'permission';
    sourceAgentFolder: string;
    requestId: string;
    appId: string;
    runId?: string | null;
    status: 'resolved' | 'cancelled';
    resolution: Record<string, unknown>;
    approverRef?: string | null;
    permissionCallbackClaim: PermissionCallbackClaimReference;
}
interface PermissionCallbackBackend {
    repository: PendingInteractionRepository;
    applyDecision: (input: PermissionInteractionDecisionInput) => Promise<boolean>;
    resolve: (input: PermissionCallbackResolutionInput) => Promise<boolean>;
    resolveOutcome?: (input: PermissionCallbackResolutionInput) => Promise<PendingInteractionResolutionOutcome>;
    warn?: (context: Record<string, unknown>, message: string) => void;
}
export declare function configurePendingInteractionPermissionCallbacks(next: PermissionCallbackBackend | null): void;
export declare function replayPersistedPermissionDecisionForRequest(input: {
    appId?: string | null;
    sourceAgentFolder: string;
    requestId: string;
}): Promise<PermissionApprovalDecision | null>;
export interface DurablePermissionInteractionContext {
    scope: PermissionCallbackScope;
    requestId: string;
    batchCallbackId: string | null;
    sourceAgentFolder: string;
    targetJid: string | null;
    approvalContextJid: string | null;
    threadId: string | null;
    decisionPolicy: PermissionApprovalRequest['decisionPolicy'] | null;
    decisionOptions: PermissionApprovalDecisionMode[];
    externalPromptMessageId: string | null;
    externalPromptProvider: string | null;
    externalPromptConversationId: string | null;
    externalPromptThreadId: string | null;
    providerAliases: string[];
    request: PermissionApprovalRequest;
    claim?: PermissionCallbackClaim;
    fullView?: DurablePermissionFullView;
}
export declare function findDurablePermissionInteractionByRequestId(input: {
    scope: PermissionCallbackScope;
    providerAlias?: string;
}): Promise<DurablePermissionInteractionContext | null>;
export type PermissionCallbackClaimResult = {
    status: 'claimed';
    claim: PermissionCallbackClaimReference;
    persistedClaim?: PermissionCallbackClaim;
} | {
    status: 'already_decided';
    ownerless?: true;
} | {
    status: 'retryable';
};
export declare function claimPermissionInteractionCallback(input: {
    scope: PermissionCallbackScope;
    mode: PermissionCallbackClaim['intent']['mode'];
    approverRef: string;
    matchKind: PermissionCallbackClaim['match']['kind'];
    providerAlias?: string;
    expireReviewEach?: boolean;
    recoveredClaim?: PermissionCallbackClaim;
    claimedAt?: string;
    claimId?: string;
}): Promise<PermissionCallbackClaimResult>;
export declare function releasePermissionInteractionCallback(input: {
    claim: PermissionCallbackClaimReference;
}): Promise<boolean>;
export declare function settlePermissionInteractionCallback(input: {
    claim: PermissionCallbackClaimReference;
}): Promise<boolean>;
export declare function resolveDurablePermissionInteractionByRequestId(input: {
    claim: PermissionCallbackClaimReference;
    reason?: string | null;
}): Promise<boolean>;
export {};
