import { MessageDeliveryResult, MessageSendOptions, PermissionApprovalCancellation, PermissionApprovalDecision, PermissionApprovalRequest, RichInteractionRequest, UserQuestionCancellation, UserQuestionRequest } from '../domain/types.js';
import { type ChannelOpts } from './channel-provider.js';
import type { DiscordInteraction } from './discord-types.js';
type DiscordConversationContext = {
    conversationJid: string;
    threadId?: string;
};
export declare class DiscordInteractionHandler {
    private readonly input;
    private pendingPermissions;
    private pendingQuestions;
    private readonly richForms;
    constructor(input: {
        botToken: string;
        applicationId: string;
        opts: ChannelOpts;
        postMessage: (channelId: string, body: Record<string, unknown>) => Promise<{
            id?: string;
        }>;
        sendMessage: (jid: string, text: string, options?: MessageSendOptions) => Promise<MessageDeliveryResult>;
        resolveInteractionConversationContext: (channelId: string) => Promise<DiscordConversationContext>;
    });
    dropPendingInteraction(kind: 'permission' | 'question', request: PermissionApprovalRequest | UserQuestionRequest): void;
    cancelPendingPermission(cancellation: PermissionApprovalCancellation): Promise<'settled' | 'already_decided' | 'retryable' | 'not_found'>;
    cancelPendingQuestion(cancellation: UserQuestionCancellation): Promise<import("./interaction-settlement.js").InteractionCancellationResult>;
    renderRichInteraction(jid: string, render: RichInteractionRequest): Promise<boolean>;
    requestPermissionApproval(jid: string, request: PermissionApprovalRequest, onPromptDelivered?: (messageId: string) => void): Promise<PermissionApprovalDecision>;
    requestUserAnswer: (jid: string, request: UserQuestionRequest, onPromptDelivered?: (messageId: string, questionIndex?: number) => void) => Promise<import("../domain/types.js").UserQuestionResponse>;
    handleInteraction(interaction: DiscordInteraction): Promise<void>;
    clearPendingInteractions(): Promise<void>;
    private settlePermissionPrompt;
    private timeoutPermissionPrompt;
    private sendDiscordPrompt;
    private handlePermissionInteraction;
    private handleQuestionInteraction;
    private openRichFormInteraction;
    private isInteractionApproverAllowed;
    private ackInteraction;
}
export {};
