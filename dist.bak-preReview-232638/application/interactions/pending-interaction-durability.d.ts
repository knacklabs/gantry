import type { PendingInteraction, PendingInteractionKind, PendingInteractionRepository, RunLeaseRepository, TransientGrantRepository } from '../../domain/ports/worker-coordination.js';
import type { PermissionCallbackClaimReference } from '../../domain/types.js';
import { type PermissionInteractionDecisionInput } from './pending-interaction-grants.js';
import type { PermissionPersistenceBackend } from './pending-interaction-permission-recovery.js';
import { type PendingInteractionResolutionBackend, type PendingInteractionResolutionOutcome } from './pending-interaction-resolution.js';
export { DurableInteractionPersistenceError } from './pending-interaction-persistence-error.js';
type InteractionDurabilityRepository = PendingInteractionRepository & RunLeaseRepository & TransientGrantRepository;
interface InteractionDurabilityBackend extends PendingInteractionResolutionBackend {
    repository: InteractionDurabilityRepository;
}
export declare function configurePendingInteractionDurability(next: InteractionDurabilityBackend | null): void;
export declare function configurePendingInteractionPermissionPersistence(next: PermissionPersistenceBackend | null): void;
export { pendingInteractionIdempotencyKey } from './pending-interaction-idempotency.js';
export declare function recordPendingInteractionRequested(input: {
    interactionId?: string;
    kind: PendingInteractionKind;
    sourceAgentFolder: string;
    requestId: string;
    appId?: string | null;
    runId?: string | null;
    runLeaseToken?: string | null;
    runLeaseFencingVersion?: number | null;
    payload: Record<string, unknown>;
    callbackRoute?: Record<string, unknown> | null;
    ttlMs?: number;
}): Promise<boolean | PendingInteraction>;
export declare function cancelPendingQuestionInteractionIfRunLeaseInactive(input: {
    id: string;
    resolution: Record<string, unknown>;
    now?: string;
}): Promise<boolean>;
export interface ResolvePendingInteractionRecordInput {
    kind: PendingInteractionKind;
    sourceAgentFolder: string;
    requestId: string;
    appId?: string | null;
    runId?: string | null;
    status: 'resolved' | 'cancelled';
    resolution: Record<string, unknown>;
    approverRef?: string | null;
    permissionCallbackClaim?: PermissionCallbackClaimReference | null;
}
export declare function resolvePendingInteractionRecordOutcome(input: ResolvePendingInteractionRecordInput): Promise<PendingInteractionResolutionOutcome>;
export declare function resolvePendingInteractionRecord(input: ResolvePendingInteractionRecordInput): Promise<boolean>;
export { bindPendingPermissionInteractionMessage, findDurablePermissionInteractionByPromptMessage, } from './pending-interaction-prompt-binding.js';
export type { DurablePermissionPromptMessageContext, DurableQuestionCallback, } from './pending-interaction-prompt-binding.js';
export { claimPermissionInteractionCallback, findDurablePermissionInteractionByRequestId, replayPersistedPermissionDecisionForRequest, releasePermissionInteractionCallback, resolveDurablePermissionInteractionByRequestId, settlePermissionInteractionCallback, } from './pending-interaction-permission-callback.js';
export type { DurablePermissionInteractionContext } from './pending-interaction-permission-callback.js';
export { recoverDurablePermissionDecision, type DurablePermissionRecoveryLocator, type DurablePermissionRecoveryOutcome, type DurablePermissionRecoveryReceipt, type RecoverDurablePermissionDecisionHooks, } from './pending-interaction-permission-recovery-orchestrator.js';
export { samePermissionCallbackLocator } from './pending-interaction-permission-claim.js';
export declare function applyPermissionInteractionDecision(input: PermissionInteractionDecisionInput): Promise<boolean>;
export declare function resolveDurableQuestionInteractionByRequestId(input: {
    requestId: string;
    sourceAgentFolder?: string;
    questionIndex: number;
    optionIndex?: number;
    finalize?: boolean;
    appId?: string | null;
}): Promise<boolean>;
export declare function recordDurableQuestionAnswerProgress(input: {
    requestId: string;
    sourceAgentFolder: string;
    answers: Record<string, string | string[]>;
    completedQuestionIndexes?: number[];
    appId?: string | null;
}): Promise<boolean>;
export declare function isActiveRunLeaseForInteraction(input: {
    runId?: string | null;
    runLeaseToken?: string | null;
    runLeaseFencingVersion?: number | null;
}): Promise<boolean>;
export declare function recordRunScopedTransientGrant(input: {
    appId?: string | null;
    runId: string;
    runLeaseToken?: string | null;
    runLeaseFencingVersion?: number | null;
    grant: Record<string, unknown>;
}): Promise<void>;
