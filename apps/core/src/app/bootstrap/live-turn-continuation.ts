import type { NewMessage } from '../../domain/types.js';
import { formatMessages } from '../../messaging/router.js';
import { buildPendingMessagesContinuationIdempotencyKey } from '../../runtime/pending-message-replay.js';
import { resolveNonSelfSenderIds } from '../../runtime/session-resume-runtime.js';

export function buildLiveTurnContinuation(input: {
  messages: readonly NewMessage[] | undefined;
  itemIds: readonly string[];
  timezone: string;
}): {
  text: string;
  senderUserIds: readonly string[];
  idempotencyKey: string;
} | null {
  if (!input.messages?.length) return null;
  const messages = [...input.messages];
  return {
    text: formatMessages(messages, input.timezone),
    senderUserIds: resolveNonSelfSenderIds(messages),
    idempotencyKey: buildPendingMessagesContinuationIdempotencyKey({
      itemIds: input.itemIds,
    }),
  };
}
