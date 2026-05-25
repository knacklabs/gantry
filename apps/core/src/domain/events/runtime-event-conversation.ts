import type {
  ConversationId,
  ConversationThreadId,
} from '../conversation/conversation.js';

const CANONICAL_CONVERSATION_PREFIX = 'conversation:';
const CONTROL_CONVERSATION_PREFIX = 'control:';
const CANONICAL_THREAD_PREFIX = 'thread:';

export function normalizeRuntimeEventConversationId(
  conversationId: ConversationId | undefined,
): ConversationId | undefined {
  const trimmed = conversationId?.trim();
  if (!trimmed) return conversationId;
  if (
    trimmed.startsWith(CANONICAL_CONVERSATION_PREFIX) ||
    trimmed.startsWith(CONTROL_CONVERSATION_PREFIX)
  ) {
    return trimmed as ConversationId;
  }
  return `${CANONICAL_CONVERSATION_PREFIX}${trimmed}` as ConversationId;
}

export function normalizeRuntimeEventThreadId(input: {
  conversationId: ConversationId | undefined;
  threadId: ConversationThreadId | undefined;
}): ConversationThreadId | undefined {
  const threadId = input.threadId?.trim();
  if (!threadId) return input.threadId;
  if (threadId.startsWith(CANONICAL_THREAD_PREFIX)) {
    return threadId as ConversationThreadId;
  }
  const conversationId = normalizeRuntimeEventConversationId(
    input.conversationId,
  )?.trim();
  if (!conversationId?.startsWith(CANONICAL_CONVERSATION_PREFIX)) {
    return threadId as ConversationThreadId;
  }
  const providerJid = conversationId
    .slice(CANONICAL_CONVERSATION_PREFIX.length)
    .trim();
  return providerJid
    ? (`${CANONICAL_THREAD_PREFIX}${providerJid}:${threadId}` as ConversationThreadId)
    : (threadId as ConversationThreadId);
}
