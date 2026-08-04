import type { Api } from 'grammy';
import type { PermissionApprovalDecision, PermissionApprovalRequest, PermissionCallbackScope } from '../../domain/types.js';
type PendingTelegramPermission = {
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
    timer?: ReturnType<typeof setTimeout>;
    resolve: (decision: PermissionApprovalDecision) => void;
};
export declare function claimAndSettleTelegramPermissionPrompt(input: {
    providerAlias: string;
    mode: NonNullable<PermissionApprovalDecision['mode']>;
    approverRef: string;
    reason: string;
    pendingPrompts: Map<string, PendingTelegramPermission>;
    api: Api | null;
    sanitizeErrorMessage: (err: unknown) => string;
}): Promise<'settled' | 'already_decided' | 'ownerless' | 'retryable'>;
export {};
