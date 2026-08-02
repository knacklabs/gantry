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
export declare function requestTelegramPermissionApproval(input: {
    interactionCallbacksEnabled: boolean;
    botConnected: boolean;
    jid: string;
    request: PermissionApprovalRequest;
    timeoutMs: number;
    pendingPrompts: Map<string, PendingTelegramPermission>;
    sendPrompt: (input: {
        chatId: string;
        request: PermissionApprovalRequest;
        callbackId: string;
        timeoutMs: number;
        threadOpts: {
            message_thread_id?: number;
        };
    }) => Promise<{
        message_id: number;
    }>;
    settlePrompt: (providerAlias: string, mode: NonNullable<PermissionApprovalDecision['mode']>, approverRef: string, reason: string) => Promise<'settled' | 'already_decided' | 'ownerless' | 'retryable'>;
    onPromptDelivered?: (messageId: string) => void;
    sanitizeErrorMessage: (err: unknown) => string;
}): Promise<PermissionApprovalDecision>;
export {};
