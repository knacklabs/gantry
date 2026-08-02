import type { AppId } from '../../domain/app/app.js';
import type { ProviderAccountId } from '../../domain/provider/provider.js';
import type { Conversation, ConversationId, ConversationThread, ConversationThreadId } from '../../domain/conversation/conversation.js';
import type { Message } from '../../domain/messages/messages.js';
import type { ConversationRepository, MessageRepository } from '../../domain/ports/repositories.js';
export declare class ConversationControlService {
    private readonly deps;
    constructor(deps: {
        conversations: ConversationRepository;
        messages: MessageRepository;
    });
    list(input: {
        appId: AppId;
        providerAccountId?: ProviderAccountId;
    }): Promise<Conversation[]>;
    get(input: {
        appId: AppId;
        conversationId: ConversationId;
    }): Promise<Conversation>;
    listThreads(input: {
        appId: AppId;
        conversationId: ConversationId;
    }): Promise<ConversationThread[]>;
    listMessages(input: {
        appId: AppId;
        conversationId: ConversationId;
        threadId?: ConversationThreadId;
        after?: string;
        limit?: number;
    }): Promise<Message[]>;
}
