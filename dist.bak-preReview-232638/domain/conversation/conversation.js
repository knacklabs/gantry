export function canonicalConversationThreadId(input) {
    const threadId = input.threadId?.trim();
    if (!threadId)
        return undefined;
    const accountPrefix = `thread:${input.conversation.providerAccountId}:`;
    if (threadId.startsWith(accountPrefix)) {
        return threadId;
    }
    return `${accountPrefix}${conversationJidForThreadId(input.conversation)}:${threadId}`;
}
function conversationJidForThreadId(conversation) {
    const scopedPrefix = `conversation:${conversation.providerAccountId}:`;
    const id = String(conversation.id);
    if (id.startsWith(scopedPrefix))
        return id.slice(scopedPrefix.length);
    if (id.startsWith('conversation:'))
        return id.slice('conversation:'.length);
    return String(conversation.externalRef?.value ?? id);
}
