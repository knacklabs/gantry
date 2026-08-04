import { ApplicationError } from '../common/application-error.js';
function assertConversationAccess(conversation, appId) {
    if (conversation.appId !== appId) {
        throw new ApplicationError('FORBIDDEN', 'API key cannot access this conversation');
    }
}
export class ConversationControlService {
    deps;
    constructor(deps) {
        this.deps = deps;
    }
    async list(input) {
        return await this.deps.conversations.listConversations(input);
    }
    async get(input) {
        const conversation = await this.deps.conversations.getConversation(input.conversationId);
        if (!conversation) {
            throw new ApplicationError('NOT_FOUND', 'Conversation not found');
        }
        assertConversationAccess(conversation, input.appId);
        return conversation;
    }
    async listThreads(input) {
        const conversation = await this.get(input);
        return await this.deps.conversations.listThreads(conversation.id);
    }
    async listMessages(input) {
        const conversation = await this.get(input);
        if (input.threadId) {
            const thread = await this.deps.conversations.getThread(input.threadId);
            if (!thread || thread.conversationId !== conversation.id) {
                throw new ApplicationError('NOT_FOUND', 'Conversation thread not found');
            }
        }
        return await this.deps.messages.listMessages({
            conversationId: conversation.id,
            threadId: input.threadId,
            after: input.after,
            limit: input.limit,
        });
    }
}
