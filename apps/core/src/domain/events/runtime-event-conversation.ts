import type { ConversationId } from '../conversation/conversation.js';

const CANONICAL_CONVERSATION_PREFIX = 'conversation:';
const CONTROL_CONVERSATION_PREFIX = 'control:';

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
