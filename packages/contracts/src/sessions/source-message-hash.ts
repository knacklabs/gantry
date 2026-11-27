import type { SourceMessage } from './source-channel.js';
/** JSON array order is the v1 source-content hash protocol. Display names are mutable. */
export function sourceMessageHashInput(
  message: Omit<SourceMessage, 'contentHash'>,
): string {
  return JSON.stringify([
    message.sourceMessageId,
    message.sourcePosition,
    message.authorId,
    message.authorKind,
    message.text,
    message.createdAt,
    message.replyToSourceId,
    message.revisionId,
    message.origin,
    message.runtimeOutputId ?? null,
    message.answerGoalId ?? null,
  ]);
}
