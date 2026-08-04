const CANONICAL_CONVERSATION_PREFIX = 'conversation:';
const CONTROL_CONVERSATION_PREFIX = 'control:';
const CANONICAL_THREAD_PREFIX = 'thread:';
export function normalizeRuntimeEventConversationId(conversationId) {
    const trimmed = conversationId?.trim();
    if (!trimmed)
        return conversationId;
    if (trimmed.startsWith(CANONICAL_CONVERSATION_PREFIX) ||
        trimmed.startsWith(CONTROL_CONVERSATION_PREFIX)) {
        return trimmed;
    }
    return `${CANONICAL_CONVERSATION_PREFIX}${trimmed}`;
}
export function normalizeRuntimeEventThreadId(input) {
    const threadId = input.threadId?.trim();
    if (!threadId)
        return input.threadId;
    if (threadId.startsWith(CANONICAL_THREAD_PREFIX)) {
        return threadId;
    }
    const conversationId = normalizeRuntimeEventConversationId(input.conversationId)?.trim();
    if (!conversationId?.startsWith(CANONICAL_CONVERSATION_PREFIX)) {
        return threadId;
    }
    const providerJid = conversationId
        .slice(CANONICAL_CONVERSATION_PREFIX.length)
        .trim();
    return providerJid
        ? `${CANONICAL_THREAD_PREFIX}${providerJid}:${threadId}`
        : threadId;
}
