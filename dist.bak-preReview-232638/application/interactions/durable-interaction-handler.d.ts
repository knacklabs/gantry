import type { PermissionApprovalDecision, PermissionApprovalRequest, UserQuestionRequest, UserQuestionResponse } from '../../domain/types.js';
import { cancelPendingQuestionInteractionIfRunLeaseInactive, recordPendingInteractionRequested, resolvePendingInteractionRecord } from './pending-interaction-durability.js';
import type { PendingInteractionResolutionOutcome } from './pending-interaction-resolution.js';
export { durablePermissionRequestSnapshot } from './pending-interaction-permission-envelope.js';
export interface DurableInteractionOperations {
    record: typeof recordPendingInteractionRequested;
    resolve: typeof resolvePendingInteractionRecord;
    cancelPendingQuestionInteractionIfRunLeaseInactive: typeof cancelPendingQuestionInteractionIfRunLeaseInactive;
}
export declare function beginDurablePermissionInteraction(input: {
    request: PermissionApprovalRequest;
    sourceAgentFolder: string;
    payload: Record<string, unknown>;
    callbackRoute?: Record<string, unknown> | null;
    operations?: DurableInteractionOperations;
}): Promise<void>;
export declare function finishDurablePermissionInteraction(input: {
    request: PermissionApprovalRequest;
    sourceAgentFolder: string;
    decision: PermissionApprovalDecision;
    updatedPermissions?: PermissionApprovalDecision['updatedPermissions'];
    operations?: DurableInteractionOperations;
}): Promise<boolean>;
export declare function resolveDurablePermissionInteraction(input: {
    request: PermissionApprovalRequest;
    sourceAgentFolder: string;
    decision: PermissionApprovalDecision;
    updatedPermissions?: PermissionApprovalDecision['updatedPermissions'];
    operations?: DurableInteractionOperations;
}): Promise<boolean>;
export declare function resolveDurablePermissionInteractionOutcome(input: {
    request: PermissionApprovalRequest;
    sourceAgentFolder: string;
    decision: PermissionApprovalDecision;
    updatedPermissions?: PermissionApprovalDecision['updatedPermissions'];
    operations?: DurableInteractionOperations;
}): Promise<PendingInteractionResolutionOutcome>;
export declare function runDurablePermissionInteraction(input: {
    request: PermissionApprovalRequest;
    sourceAgentFolder: string;
    prompt: (request: PermissionApprovalRequest) => Promise<PermissionApprovalDecision>;
    beforePrompt?: () => Promise<void> | void;
    afterDecision?: (decision: PermissionApprovalDecision) => Promise<void> | void;
    operations?: DurableInteractionOperations;
}): Promise<{
    decision: PermissionApprovalDecision;
    resolved: boolean;
}>;
export declare function beginDurableQuestionInteraction(input: {
    request: UserQuestionRequest;
    sourceAgentFolder: string;
    payload?: Record<string, unknown>;
    callbackRoute?: Record<string, unknown> | null;
    operations?: DurableInteractionOperations;
}): Promise<boolean>;
export declare function finishDurableQuestionInteraction(input: {
    request: UserQuestionRequest;
    sourceAgentFolder: string;
    response: UserQuestionResponse;
    operations?: DurableInteractionOperations;
}): Promise<boolean>;
export declare function runDurableQuestionInteraction(input: {
    request: UserQuestionRequest;
    sourceAgentFolder: string;
    prompt: (request: UserQuestionRequest) => Promise<UserQuestionResponse>;
    beforePrompt?: () => Promise<void> | void;
    operations?: DurableInteractionOperations;
}): Promise<{
    response: UserQuestionResponse;
    resolved: boolean;
}>;
