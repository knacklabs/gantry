import type { PermissionApprovalDecision, PermissionApprovalDecisionMode, PermissionApprovalRequest, PermissionCallbackClaim, PermissionCallbackScope } from '../../domain/types.js';
import { type DurablePermissionInteractionContext } from './pending-interaction-permission-callback.js';
export type DurablePermissionRecoveryLocator = {
    kind: 'scope';
    scope: PermissionCallbackScope;
    matchKind: PermissionCallbackClaim['match']['kind'];
    providerAlias: string;
} | {
    kind: 'message';
    appId: string;
    provider: string;
    conversationId: string;
    externalMessageId: string;
    threadId?: string | null;
    providerAlias: string;
};
export type DurablePermissionRecoveryReceipt = {
    status: 'resolved';
    request: PermissionApprovalRequest | null;
    decision: PermissionApprovalDecision;
    context: DurablePermissionInteractionContext;
    text?: string;
} | {
    status: 'expired';
    request: null;
    decision: PermissionApprovalDecision;
    text: string;
};
export interface RecoverDurablePermissionDecisionHooks {
    locator: DurablePermissionRecoveryLocator;
    surfaceJid: string;
    incomingMode: PermissionApprovalDecisionMode;
    incomingApprover: string;
    authorize: (context: DurablePermissionInteractionContext) => Promise<boolean>;
    terminalize: (receipt: DurablePermissionRecoveryReceipt) => Promise<boolean>;
    feedback: (text: string) => Promise<void>;
}
export type DurablePermissionRecoveryOutcome = 'resolved' | 'inactive' | 'wrong_surface' | 'unauthorized' | 'option_unavailable' | 'already_decided' | 'retryable';
export declare function recoverDurablePermissionDecision(hooks: RecoverDurablePermissionDecisionHooks): Promise<DurablePermissionRecoveryOutcome>;
