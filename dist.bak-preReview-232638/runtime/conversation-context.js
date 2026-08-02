const CHANNEL_CONTEXT_LIMIT = 30;
const THREAD_CONTEXT_LIMIT = 50;
const THREAD_LONG_FIRST_REPLIES = 10;
const THREAD_LONG_LATEST_REPLIES = 39;
export const CONVERSATION_CONTEXT_LIMITS = {
    channelMessages: CHANNEL_CONTEXT_LIMIT,
    threadMessages: THREAD_CONTEXT_LIMIT,
};
export async function buildConversationContextPacket(input) {
    const currentMessages = dedupeMessages(input.currentMessages);
    const activeThreadId = input.activeThreadId?.trim() || null;
    const recentChannelContextPromise = input.repository.getRecentTopLevelMessagesBefore(input.conversationJid, input.latestMessage, CHANNEL_CONTEXT_LIMIT, { providerAccountId: input.providerAccountId });
    const threadSelectionPromise = activeThreadId
        ? selectThreadContext({
            conversationJid: input.conversationJid,
            providerAccountId: input.providerAccountId,
            threadId: activeThreadId,
            latestMessage: input.latestMessage,
            currentMessages,
            repository: input.repository,
        })
        : Promise.resolve({ messages: [], rootPresent: false });
    const [recentChannelContext, threadSelection] = await Promise.all([
        recentChannelContextPromise,
        threadSelectionPromise,
    ]);
    const activeThreadContext = excludeMessages(threadSelection.messages, currentMessages);
    return {
        recentChannelContext: excludeMessages(recentChannelContext, [
            ...activeThreadContext,
            ...currentMessages,
        ]),
        activeThreadContext,
        currentMessages,
        metadata: {
            recentChannelCount: recentChannelContext.length,
            activeThreadCount: activeThreadContext.length,
            currentMessageCount: currentMessages.length,
            activeThreadId,
            recentChannelWindowComplete: recentChannelContext.length >= CHANNEL_CONTEXT_LIMIT,
            activeThreadWindowComplete: !activeThreadId || activeThreadContext.length >= THREAD_CONTEXT_LIMIT,
            activeThreadRootPresent: !activeThreadId || threadSelection.rootPresent,
        },
    };
}
function selectThreadContext(input) {
    return Promise.all([
        input.repository.getFirstThreadMessages(input.conversationJid, input.threadId, THREAD_LONG_FIRST_REPLIES + 1, { providerAccountId: input.providerAccountId }),
        input.repository.getLatestThreadMessages(input.conversationJid, input.threadId, input.latestMessage, THREAD_CONTEXT_LIMIT, { providerAccountId: input.providerAccountId }),
    ]).then(([firstMessages, latestMessages]) => {
        const boundedFirstMessages = firstMessages.filter((message) => isAtOrBeforeMessageCursor(message, input.latestMessage));
        const boundedLatestMessages = latestMessages.filter((message) => isAtOrBeforeMessageCursor(message, input.latestMessage));
        const rootPresent = boundedFirstMessages.some((message) => isThreadRootMessage(message, input.threadId));
        const combined = excludeMessages(dedupeMessages([...boundedFirstMessages, ...boundedLatestMessages]), input.currentMessages);
        if (combined.length <= THREAD_CONTEXT_LIMIT) {
            return { messages: combined, rootPresent };
        }
        const root = combined.slice(0, 1);
        const firstReplies = combined.slice(1, THREAD_LONG_FIRST_REPLIES + 1);
        const latestReplies = combined.slice(1).slice(-THREAD_LONG_LATEST_REPLIES);
        return {
            messages: dedupeMessages([...root, ...firstReplies, ...latestReplies]),
            rootPresent,
        };
    });
}
function excludeMessages(messages, excluded) {
    const excludedKeys = new Set(excluded.map(messageKey));
    return messages.filter((message) => !excludedKeys.has(messageKey(message)));
}
function dedupeMessages(messages) {
    const seen = new Set();
    const result = [];
    for (const message of [...messages].sort(compareMessages)) {
        const key = messageKey(message);
        if (seen.has(key))
            continue;
        seen.add(key);
        result.push(message);
    }
    return result;
}
function compareMessages(left, right) {
    return (left.timestamp.localeCompare(right.timestamp) ||
        left.chat_jid.localeCompare(right.chat_jid) ||
        left.id.localeCompare(right.id));
}
function isAtOrBeforeMessageCursor(message, cursor) {
    return (message.timestamp.localeCompare(cursor.timestamp) < 0 ||
        (message.timestamp === cursor.timestamp && message.id <= cursor.id));
}
function messageKey(message) {
    return `${message.chat_jid}\u0000${message.id}`;
}
function isThreadRootMessage(message, threadId) {
    return message.external_message_id === threadId || message.id === threadId;
}
