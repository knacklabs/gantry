import { MessageDeliveryResult, MessageSendOptions, PermissionApprovalDecision, PermissionApprovalRequest, ProgressUpdateOptions, RichInteractionRequest, StreamingChunkOptions, UserQuestionRequest, UserQuestionResponse } from '../../domain/types.js';
import { type SlackSnippetFallbackInput, type SlackSnippetFallbackResult } from './channel-delivery-helpers.js';
import { SlackChannelInteractions } from './channel-interactions.js';
import type { AgentTodoRender } from '../../domain/ports/task-lifecycle.js';
export declare abstract class SlackChannelDelivery extends SlackChannelInteractions {
    private interactionCallbacksEnabled;
    private readonly reactionKeys;
    protected sendSnippetFallback(_input: SlackSnippetFallbackInput): Promise<SlackSnippetFallbackResult | null>;
    connect(options?: {
        inbound?: boolean;
        interactionCallbacks?: boolean;
    }): Promise<void>;
    supportsInteractionCallbacks(): boolean;
    sendMessage(jid: string, text: string, options?: MessageSendOptions): Promise<MessageDeliveryResult | void>;
    addReaction(jid: string, messageRef: string, emoji: string): Promise<void>;
    renderAgentTodo(jid: string, render: AgentTodoRender): Promise<boolean>;
    renderRichInteraction(jid: string, render: RichInteractionRequest): Promise<boolean>;
    sendStreamingChunk(jid: string, text: string, options?: StreamingChunkOptions): Promise<boolean>;
    resetStreaming(jid: string, options?: {
        threadId?: string;
    }): void;
    sendProgressUpdate(jid: string, text: string, options?: ProgressUpdateOptions): Promise<void>;
    requestPermissionApproval(jid: string, request: PermissionApprovalRequest, onPromptDelivered?: (messageId: string) => void): Promise<PermissionApprovalDecision>;
    private loadPersistedProgress;
    private persistProgress;
    requestUserAnswer(jid: string, request: UserQuestionRequest, onPromptDelivered?: (messageId: string) => void): Promise<UserQuestionResponse>;
    syncGroups(force?: boolean): Promise<void>;
    isConnected(): boolean;
    ownsJid(jid: string): boolean;
    disconnect(): Promise<void>;
}
