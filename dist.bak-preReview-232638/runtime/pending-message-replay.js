import { createHash } from 'node:crypto';
import { encodeGroupMessageCursor, toGroupMessageCursor, } from '../shared/message-cursor.js';
export async function collectPendingMessagesSince(input) {
    const pageSize = Math.max(1, Math.floor(input.pageSize));
    const maxMessages = Math.max(1, Math.floor(input.maxMessages ?? input.pageSize));
    const messages = [];
    let cursor = input.sinceCursor;
    while (messages.length < maxMessages) {
        const limit = pageSize;
        const batch = await input.getMessagesSince(input.chatJid, cursor, limit, input.options);
        if (batch.length === 0) {
            return selectPendingMessageBatch(messages, false);
        }
        const remaining = maxMessages - messages.length;
        const acceptedBatch = batch.slice(0, remaining);
        messages.push(...acceptedBatch);
        const lastAcceptedMessage = acceptedBatch[acceptedBatch.length - 1];
        if (!lastAcceptedMessage) {
            return selectPendingMessageBatch(messages, true);
        }
        const nextCursor = encodeGroupMessageCursor(toGroupMessageCursor(lastAcceptedMessage));
        if (nextCursor === cursor) {
            throw new Error('Pending message replay cursor did not advance');
        }
        cursor = nextCursor;
        if (acceptedBatch.length < batch.length) {
            return selectPendingMessageBatch(messages, true);
        }
        if (batch.length < limit) {
            return selectPendingMessageBatch(messages, false);
        }
    }
    return selectPendingMessageBatch(messages, true);
}
function selectPendingMessageBatch(messages, hasMore) {
    const firstControlled = messages.findIndex((message) => message.responseSchema !== undefined ||
        message.agentControls !== undefined);
    if (firstControlled < 0) {
        return { messages, hasMore, cursorAfter: messagesCursor(messages) };
    }
    const selected = messages.slice(0, firstControlled + 1);
    return {
        messages: selected,
        hasMore: hasMore || selected.length < messages.length,
        cursorAfter: messagesCursor(selected),
        responseSchema: messages[firstControlled].responseSchema,
        agentControls: messages[firstControlled].agentControls,
    };
}
export function buildPendingMessagesContinuationIdempotencyKey(input) {
    const hash = createHash('sha256');
    hash.update(input.queueJid);
    hash.update('\0');
    hash.update(input.sinceCursor);
    hash.update('\0');
    hash.update(input.cursorAfter);
    hash.update('\0');
    for (const message of input.messages) {
        hash.update(String(message.id));
        hash.update('\0');
    }
    return `continuation:${hash.digest('hex')}`;
}
function messagesCursor(messages) {
    const lastMessage = messages[messages.length - 1];
    return lastMessage
        ? encodeGroupMessageCursor(toGroupMessageCursor(lastMessage))
        : null;
}
