import { PermissionApprovalDecision, PermissionApprovalRequest, UserQuestionCancellation, UserQuestionRequest } from '../../domain/types.js';
import { TelegramChannelPolling } from './channel-polling.js';
import { PendingUserQuestionState } from './channel-shared.js';
import { type InteractionCancellationResult } from '../interaction-settlement.js';
export interface TelegramDownloadedFile {
    filePath: string;
    storageRef: string;
}
export declare abstract class TelegramChannelPrompts extends TelegramChannelPolling {
    protected pendingUserQuestionKey(appId: string, sourceAgentFolder: string, requestId: string, questionIndex: number): string;
    cancelPendingQuestion(cancellation: UserQuestionCancellation): Promise<InteractionCancellationResult>;
    protected formatUserQuestionButtonLabel(optionLabel: string, optionIndex: number, multiSelect: boolean, isSelected: boolean): string;
    protected buildUserQuestionKeyboard(callbackId: string, question: UserQuestionRequest['questions'][number], selectedOptionIndexes: Set<number>): {
        inline_keyboard: Array<Array<{
            text: string;
            callback_data: string;
        }>>;
    };
    protected sendPermissionPromptMessage(input: {
        chatId: string;
        request: PermissionApprovalRequest;
        callbackId: string;
        timeoutMs: number;
        threadOpts: {
            message_thread_id?: number;
        };
    }): Promise<{
        message_id: number;
    }>;
    private sendSplitPermissionReviewMessages;
    private sendPermissionFullViewDocument;
    private telegramConversationMatchesChat;
    protected sendUserQuestionPromptMessage(input: {
        chatId: string;
        requestId: string;
        questionIndex: number;
        callbackId: string;
        question: UserQuestionRequest['questions'][number];
        threadOpts: {
            message_thread_id?: number;
        };
    }): Promise<{
        messageId: number;
        promptText: string;
        promptIsHtml: boolean;
    }>;
    protected isTelegramApproverAuthorized(chatId: string, userId: string, sourceAgentFolder: string, decisionPolicy?: PermissionApprovalRequest['decisionPolicy'], threadId?: string): Promise<boolean>;
    protected claimAndResolvePermissionPrompt(providerAlias: string, mode: NonNullable<PermissionApprovalDecision['mode']>, approverRef: string, reason: string): Promise<'settled' | 'already_decided' | 'ownerless' | 'retryable'>;
    protected refreshUserQuestionPrompt(pending: PendingUserQuestionState): Promise<void>;
    protected finalizeUserQuestionPrompt(pending: PendingUserQuestionState, selection: string | string[], answeredBy?: string, reason?: string): Promise<void>;
    protected tryResolveUserQuestionOtherReply(input: {
        chatId: string;
        replyToMessageId: number;
        text: string;
        userId: string;
        answeredBy: string;
    }): Promise<boolean>;
    private sendUserQuestionOtherReplyNotice;
    protected downloadFile(fileId: string, workspaceFolder: string, filename: string): Promise<TelegramDownloadedFile | null>;
}
