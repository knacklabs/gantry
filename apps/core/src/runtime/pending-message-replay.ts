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

export async function collectPendingMessagesSince(input: {
  getMessagesSince: GetMessagesSince;
  chatJid: string;
  sinceCursor: string;
  pageSize: number;
  options?: { threadId?: string | null };
}): Promise<NewMessage[]> {
  const pageSize = Math.max(1, Math.floor(input.pageSize));
  const messages: NewMessage[] = [];
  let cursor = input.sinceCursor;

  for (;;) {
    const batch = await input.getMessagesSince(
      input.chatJid,
      cursor,
      pageSize,
      input.options,
    );
    if (batch.length === 0) return messages;

    messages.push(...batch);
    const nextCursor = encodeGroupMessageCursor(
      toGroupMessageCursor(batch[batch.length - 1]),
    );
    if (nextCursor === cursor) {
      throw new Error('Pending message replay cursor did not advance');
    }
    cursor = nextCursor;

    if (batch.length < pageSize) return messages;
  }
}

export function buildPendingMessagesContinuationIdempotencyKey(input: {
  queueJid: string;
  messages: readonly Pick<NewMessage, 'id'>[];
}): string {
  const hash = createHash('sha256');
  hash.update(input.queueJid);
  hash.update('\0');
  for (const message of input.messages) {
    hash.update(String(message.id));
    hash.update('\0');
  }
  return `continuation:${hash.digest('hex')}`;
}
