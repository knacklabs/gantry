import type { NewMessage } from '../../domain/types.js';
import type {
  Conversation,
  ConversationId,
  ConversationThread,
  ConversationThreadId,
} from '../../domain/conversation/conversation.js';
import type { ConversationRepository } from '../../domain/ports/repositories.js';
import type { RuntimeEventPublishInput } from '../../domain/events/events.js';
import { RUNTIME_EVENT_TYPES } from '../../domain/events/runtime-event-types.js';
import type {
  RuntimeChatMetadataRepository,
  RuntimeMessageRepository,
} from '../../domain/repositories/ops-repo.js';
import type { AppId } from '../../domain/app/app.js';
import { ApplicationError } from '../common/application-error.js';

export type ConversationMessageQueueIntent = {
  conversationJid: string;
  threadId: string | null;
  queueKey: string;
};

type ConversationMessageThreadRouting = {
  publicThreadId: ConversationThreadId | null;
  runtimeThreadId: string | null;
};

export class ConversationMessageIngressModule {
  constructor(
    private readonly deps: {
      conversations: ConversationRepository;
      ops: RuntimeChatMetadataRepository & RuntimeMessageRepository;
      runtimeEvents: {
        publish(input: RuntimeEventPublishInput): Promise<{ eventId: number }>;
      };
      isConversationRoutable: (conversationJid: string) => boolean;
      providerForConversationJid: (conversationJid: string) => string;
      makeQueueKey: (
        conversationJid: string,
        threadId: string | null,
      ) => string;
      now: () => string;
      createId: () => string;
    },
  ) {}

  async acceptMessage(input: {
    appId: string;
    invocationId: string;
    conversationId: string;
    threadId?: string | null;
    message: string;
    senderId?: string | null;
    senderName?: string | null;
    correlationId?: string | null;
  }): Promise<{
    messageId: string;
    conversationId: string;
    threadId: string | null;
    acceptedEventId: number;
    enqueue: ConversationMessageQueueIntent;
  }> {
    const text = input.message.trim();
    if (!text) {
      throw new ApplicationError('INVALID_REQUEST', 'message is required');
    }

    const conversation = await this.requireConversation({
      appId: input.appId,
      conversationId: input.conversationId,
    });
    const conversationJid = resolveConversationJid(conversation);
    if (
      !conversationJid ||
      !this.deps.isConversationRoutable(conversationJid)
    ) {
      throw new ApplicationError(
        'NOT_FOUND',
        'Conversation is not configured for runtime routing',
      );
    }

    const thread = await this.resolveThreadRouting({
      appId: input.appId,
      conversation,
      threadId: input.threadId ?? null,
    });
    const publicThreadId = thread.publicThreadId;
    const runtimeThreadId = thread.runtimeThreadId;
    const now = this.deps.now();
    const messageId = this.deps.createId();
    const senderId = input.senderId?.trim() || 'external-ingress';
    const senderName = input.senderName?.trim() || 'External System';
    const provider = this.deps.providerForConversationJid(conversationJid);
    const message: NewMessage = {
      id: messageId,
      chat_jid: conversationJid,
      provider,
      sender: senderId,
      sender_name: senderName,
      content: text,
      timestamp: now,
      is_from_me: false,
      is_bot_message: false,
      external_message_id: `external-ingress:${input.invocationId}`,
      thread_id: runtimeThreadId ?? undefined,
    };

    await this.deps.ops.storeChatMetadata(
      conversationJid,
      now,
      conversation.title ?? conversationJid,
      provider,
      conversation.kind === 'group' || conversation.kind === 'channel',
    );
    await this.deps.ops.storeMessage(message);
    const accepted = await this.deps.runtimeEvents.publish({
      appId: input.appId as AppId,
      conversationId: conversation.id,
      threadId: publicThreadId ?? undefined,
      eventType: RUNTIME_EVENT_TYPES.CONVERSATION_MESSAGE_INBOUND,
      actor: senderId,
      correlationId: input.correlationId ?? null,
      responseMode: 'none',
      payload: {
        messageId,
        conversationId: conversation.id,
        threadId: publicThreadId,
        direction: 'inbound',
        deliveryStatus: 'accepted',
        sender: {
          id: senderId,
          name: senderName,
        },
        text,
      },
      createdAt: now,
    });

    return {
      messageId,
      conversationId: conversation.id,
      threadId: publicThreadId,
      acceptedEventId: accepted.eventId,
      enqueue: {
        conversationJid,
        threadId: runtimeThreadId,
        queueKey: this.deps.makeQueueKey(conversationJid, runtimeThreadId),
      },
    };
  }

  private async requireConversation(input: {
    appId: string;
    conversationId: string;
  }): Promise<Conversation> {
    const conversation = await this.deps.conversations.getConversation(
      input.conversationId as ConversationId,
    );
    if (!conversation) {
      throw new ApplicationError('NOT_FOUND', 'Conversation not found');
    }
    if (conversation.appId !== (input.appId as AppId)) {
      throw new ApplicationError(
        'FORBIDDEN',
        'Ingress cannot access this conversation',
      );
    }
    if (conversation.status !== 'active') {
      throw new ApplicationError('CONFLICT', 'Conversation is not active');
    }
    return conversation;
  }

  private async resolveThreadRouting(input: {
    appId: string;
    conversation: Conversation;
    threadId: string | null;
  }): Promise<ConversationMessageThreadRouting> {
    if (!input.threadId) {
      return { publicThreadId: null, runtimeThreadId: null };
    }
    const thread = await this.deps.conversations.getThread(
      input.threadId as ConversationThreadId,
    );
    if (!thread) {
      const runtimeThreadId = resolveRuntimeThreadIdFromCanonical(
        input.threadId,
        input.conversation,
      );
      if (runtimeThreadId) {
        return {
          publicThreadId: input.threadId as ConversationThreadId,
          runtimeThreadId,
        };
      }
      throw new ApplicationError('NOT_FOUND', 'Conversation thread not found');
    }
    if (
      thread.appId !== (input.appId as AppId) ||
      thread.conversationId !== input.conversation.id
    ) {
      throw new ApplicationError('NOT_FOUND', 'Conversation thread not found');
    }
    if (thread.status !== 'active') {
      throw new ApplicationError(
        'CONFLICT',
        'Conversation thread is not active',
      );
    }
    if (!resolveRuntimeThreadId(thread)) {
      throw new ApplicationError(
        'NOT_FOUND',
        'Conversation thread is not configured for runtime routing',
      );
    }
    return {
      publicThreadId: thread.id,
      runtimeThreadId: resolveRuntimeThreadId(thread),
    };
  }
}

function resolveConversationJid(conversation: Conversation): string | null {
  if (conversation.id.startsWith('conversation:')) {
    const jid = conversation.id.slice('conversation:'.length).trim();
    if (jid) return jid;
  }
  const refValue = conversation.externalRef?.value?.trim();
  return refValue?.includes(':') ? refValue : null;
}

function resolveRuntimeThreadId(thread: ConversationThread): string | null {
  const refValue = thread.externalRef?.value?.trim();
  if (refValue) return refValue;
  const conversationId = thread.conversationId;
  if (!conversationId.startsWith('conversation:')) return null;
  const conversationJid = conversationId.slice('conversation:'.length).trim();
  const prefix = `thread:${conversationJid}:`;
  return thread.id.startsWith(prefix) ? thread.id.slice(prefix.length) : null;
}

function resolveRuntimeThreadIdFromCanonical(
  threadId: string,
  conversation: Conversation,
): string | null {
  const conversationJid = resolveConversationJid(conversation);
  if (!conversationJid) return null;
  const prefix = `thread:${conversationJid}:`;
  if (!threadId.startsWith(prefix)) return null;
  const runtimeThreadId = threadId.slice(prefix.length).trim();
  return runtimeThreadId ? runtimeThreadId : null;
}
