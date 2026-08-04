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
export declare function bindTelegramPermission(request: PermissionApprovalRequest, chatId: string, messageId: number | undefined, callbackId: string): Promise<boolean>;
export declare function registerAndBindTelegramPermissionPrompt(input: {
    jid: string;
    request: PermissionApprovalRequest;
    chatId: string;
    messageId: number;
    callback: PendingTelegramPermission['callback'];
    fallbackTimeoutMs: number;
    pendingPrompts: Map<string, PendingTelegramPermission>;
    onTimeout: (retryWindowMs: number) => void;
    onPromptDelivered?: (messageId: string) => void;
    sanitizeErrorMessage: (err: unknown) => string;
}): Promise<{
    decision: Promise<PermissionApprovalDecision>;
}>;
export {};
