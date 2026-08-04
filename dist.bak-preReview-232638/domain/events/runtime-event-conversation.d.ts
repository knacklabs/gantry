import type { ConversationId, ConversationThreadId } from '../conversation/conversation.js';
export declare function normalizeRuntimeEventConversationId(conversationId: ConversationId | undefined): ConversationId | undefined;
export declare function normalizeRuntimeEventThreadId(input: {
    conversationId: ConversationId | undefined;
    threadId: ConversationThreadId | undefined;
}): ConversationThreadId | undefined;
