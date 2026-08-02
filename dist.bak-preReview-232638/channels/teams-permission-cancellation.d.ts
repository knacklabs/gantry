import type { PermissionApprovalCancellation, PermissionApprovalRequest } from '../domain/types.js';
type PendingPermission = {
    request: Pick<PermissionApprovalRequest, 'requestId' | 'appId' | 'sourceAgentFolder'>;
};
type PermissionSettlementCallbackResult = 'settled' | 'already_decided' | 'ownerless' | 'retryable';
export declare function cancelPendingTeamsPermission(pendingPermissions: ReadonlyMap<string, PendingPermission>, cancellation: PermissionApprovalCancellation, settle: (providerAlias: string, reason: string) => Promise<PermissionSettlementCallbackResult>): Promise<'settled' | 'already_decided' | 'retryable' | 'not_found'>;
export {};
