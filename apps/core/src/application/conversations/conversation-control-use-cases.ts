import type { AppId } from '../../domain/app/app.js';
import type { ProviderAccountId } from '../../domain/provider/provider.js';
import type {
  Conversation,
  ConversationId,
  ConversationThread,
  ConversationThreadId,
} from '../../domain/conversation/conversation.js';
import type { Message } from '../../domain/messages/messages.js';
import type {
  ConversationRepository,
  MessageRepository,
} from '../../domain/ports/repositories.js';
import { ApplicationError } from '../common/application-error.js';

function assertConversationAccess(
  conversation: Conversation,
  appId: AppId,
): void {
  if (conversation.appId !== appId) {
    throw new ApplicationError(
      'FORBIDDEN',
      'API key cannot access this conversation',
    );
  }
}

export class ConversationControlService {
  constructor(
    private readonly deps: {
      conversations: ConversationRepository;
      messages: MessageRepository;
    },
  ) {}

  async list(input: {
    appId: AppId;
    providerAccountId?: ProviderAccountId;
  }): Promise<Conversation[]> {
    return await this.deps.conversations.listConversations(input);
  }

  async get(input: {
    appId: AppId;
    conversationId: ConversationId;
  }): Promise<Conversation> {
    const conversation = await this.deps.conversations.getConversation(
      input.conversationId,
    );
    if (!conversation) {
      throw new ApplicationError('NOT_FOUND', 'Conversation not found');
    }
    assertConversationAccess(conversation, input.appId);
    return conversation;
  }

  async listThreads(input: {
    appId: AppId;
    conversationId: ConversationId;
  }): Promise<ConversationThread[]> {
    const conversation = await this.get(input);
    return await this.deps.conversations.listThreads(conversation.id);
  }

  async listMessages(input: {
    appId: AppId;
    conversationId: ConversationId;
    threadId?: ConversationThreadId;
    after?: string;
    limit?: number;
  }): Promise<Message[]> {
    const conversation = await this.get(input);
    if (input.threadId) {
      const thread = await this.deps.conversations.getThread(input.threadId);
      if (!thread || thread.conversationId !== conversation.id) {
        throw new ApplicationError(
          'NOT_FOUND',
          'Conversation thread not found',
        );
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
