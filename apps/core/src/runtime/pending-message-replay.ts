import { createHash } from 'node:crypto';

import type { NewMessage } from '../domain/types.js';
import {
  encodeGroupMessageCursor,
  toGroupMessageCursor,
} from '../shared/message-cursor.js';

export type GetMessagesSince = (
  conversationJid: string,
  sinceCursor: string,
  limit?: number,
  options?: { threadId?: string | null },
) => Promise<NewMessage[]>;

export interface PendingMessageReplay {
  messages: NewMessage[];
  hasMore: boolean;
  cursorAfter: string | null;
}

export async function collectPendingMessagesSince(input: {
  getMessagesSince: GetMessagesSince;
  chatJid: string;
  sinceCursor: string;
  pageSize: number;
  maxMessages?: number;
  options?: { threadId?: string | null };
}): Promise<PendingMessageReplay> {
  const pageSize = Math.max(1, Math.floor(input.pageSize));
  const maxMessages = Math.max(
    1,
    Math.floor(input.maxMessages ?? input.pageSize),
  );
  const messages: NewMessage[] = [];
  let cursor = input.sinceCursor;

  while (messages.length < maxMessages) {
    const limit = pageSize;
    const batch = await input.getMessagesSince(
      input.chatJid,
      cursor,
      limit,
      input.options,
    );
    if (batch.length === 0) {
      return {
        messages,
        hasMore: false,
        cursorAfter: messagesCursor(messages),
      };
    }

    const remaining = maxMessages - messages.length;
    const acceptedBatch = batch.slice(0, remaining);
    messages.push(...acceptedBatch);
    const lastAcceptedMessage = acceptedBatch[acceptedBatch.length - 1];
    if (!lastAcceptedMessage) {
      return {
        messages,
        hasMore: true,
        cursorAfter: messagesCursor(messages),
      };
    }
    const nextCursor = encodeGroupMessageCursor(
      toGroupMessageCursor(lastAcceptedMessage),
    );
    if (nextCursor === cursor) {
      throw new Error('Pending message replay cursor did not advance');
    }
    cursor = nextCursor;

    if (acceptedBatch.length < batch.length) {
      return { messages, hasMore: true, cursorAfter: cursor };
    }
    if (batch.length < limit) {
      return { messages, hasMore: false, cursorAfter: cursor };
    }
  }
  return { messages, hasMore: true, cursorAfter: cursor };
}

export function buildPendingMessagesContinuationIdempotencyKey(input: {
  queueJid: string;
  sinceCursor: string;
  cursorAfter: string;
  messages: readonly Pick<NewMessage, 'id'>[];
}): string {
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

function messagesCursor(messages: readonly NewMessage[]): string | null {
  const lastMessage = messages[messages.length - 1];
  return lastMessage
    ? encodeGroupMessageCursor(toGroupMessageCursor(lastMessage))
    : null;
}
