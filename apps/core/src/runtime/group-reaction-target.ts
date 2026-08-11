import type { NewMessage } from '../domain/types.js';
import { firstThreadQueueId } from '../shared/thread-queue-key.js';
import { latestReactionTarget } from './continuation-receipts.js';

function slackChannelRootThreadId(
  chatJid: string,
  externalMessageId: string | null | undefined,
): string | undefined {
  if (!/^sl:[CG][A-Z0-9]+$/i.test(chatJid)) return undefined;
  const threadId = externalMessageId?.trim();
  return /^\d+\.\d+$/.test(threadId ?? '') ? threadId : undefined;
}

export function resolveGroupReactionTarget(input: {
  chatJid: string;
  routeThreadId?: string;
  messages: readonly NewMessage[];
}): {
  activeThreadId?: string;
  reactionTarget?: { messageRef: string; threadId?: string };
} {
  const latestMessage = input.messages[input.messages.length - 1];
  const selectedReactionTarget = latestReactionTarget(input.messages);
  const activeThreadId = firstThreadQueueId(
    input.routeThreadId,
    latestMessage?.thread_id,
    slackChannelRootThreadId(input.chatJid, latestMessage?.external_message_id),
  );
  const reactionTarget = selectedReactionTarget
    ? {
        messageRef: selectedReactionTarget.messageRef,
        ...(selectedReactionTarget.threadId
          ? { threadId: selectedReactionTarget.threadId }
          : selectedReactionTarget.messageIndex === input.messages.length - 1 &&
              activeThreadId
            ? { threadId: activeThreadId }
            : {}),
      }
    : undefined;
  return { activeThreadId, reactionTarget };
}
