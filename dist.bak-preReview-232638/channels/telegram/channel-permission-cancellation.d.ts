import type { PermissionApprovalCancellation, PermissionApprovalDecision, PermissionApprovalRequest, PermissionCallbackScope } from '../../domain/types.js';
export type PendingPermission = {
    callback: {
        providerAlias: string;
        scope: PermissionCallbackScope;
        matchKind: 'individual' | 'batch';
    };
    sourceAgentFolder: string;
    decisionPolicy?: PermissionApprovalRequest['decisionPolicy'];
    approvalContextJid?: string;
    request: PermissionApprovalRequest;
    chatId: string;
    messageId: number;
    timer: ReturnType<typeof setTimeout>;
    resolve: (decision: PermissionApprovalDecision) => void;
};
type PermissionSettlementResult = 'settled' | 'already_decided' | 'ownerless' | 'retryable';
export declare function cancelPendingTelegramPermission(pendingPermissions: ReadonlyMap<string, PendingPermission>, cancellation: PermissionApprovalCancellation, settle: (providerAlias: string, reason: string) => Promise<PermissionSettlementResult>): Promise<'settled' | 'already_decided' | 'retryable' | 'not_found'>;
export {};
