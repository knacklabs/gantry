import type { PermissionApprovalDecision, PermissionApprovalRequest } from '../domain/types.js';
import { type PendingTeamsPermissionPrompt, type TeamsSdkClient } from './teams-types.js';
export declare function requestTeamsPermissionApproval(input: {
    connected: boolean;
    jid: string;
    request: PermissionApprovalRequest;
    timeoutMs: number;
    onPromptDelivered?: (messageId: string) => void;
    sdkClient: TeamsSdkClient;
    pendingPermissionPrompts: Map<string, PendingTeamsPermissionPrompt>;
    settleTimeout: (providerAlias: string) => Promise<'settled' | 'already_decided' | 'ownerless' | 'retryable'>;
}): Promise<PermissionApprovalDecision>;
