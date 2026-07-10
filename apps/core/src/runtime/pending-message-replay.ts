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
  options?: { threadId?: string | null; providerAccountId?: string | null },
) => Promise<NewMessage[]>;

export interface PendingMessageReplay {
  messages: NewMessage[];
  hasMore: boolean;
  cursorAfter: string | null;
  responseSchema?: Record<string, unknown>;
}

export async function collectPendingMessagesSince(input: {
  getMessagesSince: GetMessagesSince;
  chatJid: string;
  sinceCursor: string;
  pageSize: number;
  maxMessages?: number;
  options?: { threadId?: string | null; providerAccountId?: string | null };
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
      return selectPendingMessageBatch(messages, false);
    }

    const remaining = maxMessages - messages.length;
    const acceptedBatch = batch.slice(0, remaining);
    messages.push(...acceptedBatch);
    const lastAcceptedMessage = acceptedBatch[acceptedBatch.length - 1];
    if (!lastAcceptedMessage) {
      return selectPendingMessageBatch(messages, true);
    }
    const nextCursor = encodeGroupMessageCursor(
      toGroupMessageCursor(lastAcceptedMessage),
    );
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

function selectPendingMessageBatch(
  messages: NewMessage[],
  hasMore: boolean,
): PendingMessageReplay {
  const firstSchema = messages.findIndex(
    (message) => message.responseSchema !== undefined,
  );
  if (firstSchema < 0) {
    return { messages, hasMore, cursorAfter: messagesCursor(messages) };
  }
  const selected = messages.slice(0, firstSchema + 1);
  return {
    messages: selected,
    hasMore: hasMore || selected.length < messages.length,
    cursorAfter: messagesCursor(selected),
    responseSchema: messages[firstSchema]!.responseSchema,
  };
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
