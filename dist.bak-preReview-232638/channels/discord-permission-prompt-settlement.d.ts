import type { MessageDeliveryResult, PermissionApprovalDecision, PermissionApprovalRequest, PermissionCallbackScope } from '../domain/types.js';
export interface PendingDiscordPermission {
    callback: {
        providerAlias: string;
        scope: PermissionCallbackScope;
        matchKind: 'individual' | 'batch';
    };
    request: PermissionApprovalRequest;
    channelId: string;
    externalMessageId?: string;
    resolve: (decision: PermissionApprovalDecision) => void;
    timeout: ReturnType<typeof setTimeout>;
}
export declare function timeoutRetryDelays(timeoutMs: number): [number, number];
export declare function pending(callback: PendingDiscordPermission['callback'], request: PermissionApprovalRequest, sent: MessageDeliveryResult, channelId: string, resolve: PendingDiscordPermission['resolve'], timeout: ReturnType<typeof setTimeout>): PendingDiscordPermission;
export declare function drop(pendingPermissions: Map<string, PendingDiscordPermission>, request: Pick<PermissionApprovalRequest, 'appId' | 'sourceAgentFolder' | 'requestId'>): void;
export declare function consume(pending: Pick<PendingDiscordPermission, 'channelId' | 'externalMessageId'> & {
    request: PermissionApprovalRequest | null;
}, input: {
    botToken: string;
}, decision: PermissionApprovalDecision): Promise<boolean>;
export declare function settle(pendingPermissions: Map<string, PendingDiscordPermission>, providerAlias: string, decision: PermissionApprovalDecision, input: {
    botToken: string;
}): Promise<boolean>;
