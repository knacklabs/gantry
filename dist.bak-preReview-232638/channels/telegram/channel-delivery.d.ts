import { MessageDeliveryResult, MessageSendOptions, PermissionApprovalDecision, PermissionApprovalRequest, ProgressUpdateOptions, RichInteractionRequest, StreamingChunkOptions, UserQuestionRequest, UserQuestionResponse } from '../../domain/types.js';
import type { AgentTodoRender } from '../../domain/ports/task-lifecycle.js';
import { TelegramChannelConnect } from './channel-connect.js';
export declare abstract class TelegramChannelDelivery extends TelegramChannelConnect {
    private readonly reactionKeys;
    sendMessage(jid: string, text: string, options?: MessageSendOptions): Promise<MessageDeliveryResult>;
    renderRichInteraction(jid: string, render: RichInteractionRequest): Promise<boolean>;
    addReaction(jid: string, messageRef: string, emoji: string): Promise<void>;
    sendStreamingChunk(jid: string, text: string, options?: StreamingChunkOptions): Promise<boolean>;
    sendProgressUpdate(jid: string, text: string, options?: ProgressUpdateOptions): Promise<void>;
    requestPermissionApproval(jid: string, request: PermissionApprovalRequest, onPromptDelivered?: (messageId: string) => void): Promise<PermissionApprovalDecision>;
    requestUserAnswer(jid: string, request: UserQuestionRequest, onPromptDelivered?: (messageId: string, questionIndex?: number) => void): Promise<UserQuestionResponse>;
    renderAgentTodo(jid: string, render: AgentTodoRender): Promise<boolean>;
    isConnected(): boolean;
    ownsJid(jid: string): boolean;
    disconnect(): Promise<void>;
    setTyping(jid: string, isTyping: boolean): Promise<void>;
}
