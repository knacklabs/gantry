import type { NewMessage } from '../domain/types.js';

type ReactionTarget = {
  messageRef: string;
  threadId?: string;
  messageIndex: number;
};

function findLatestReactionTarget(
  messages: readonly NewMessage[] | undefined,
): ReactionTarget | undefined {
  if (!messages) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const messageRef = message?.external_message_id;
    if (messageRef && !messageRef.startsWith('external-ingress:')) {
      return {
        messageRef,
        messageIndex: index,
        ...(message.thread_id ? { threadId: message.thread_id } : {}),
      };
    }
  }
  return undefined;
}

export function latestReactionTarget(
  messages: readonly NewMessage[] | undefined,
): { messageRef: string; threadId?: string } | undefined {
  const target = findLatestReactionTarget(messages);
  if (!target) return undefined;
  const { messageIndex: _messageIndex, ...publicTarget } = target;
  return publicTarget;
}

export async function acknowledgeContinuationReceipt(input: {
  jid: string;
  messages: readonly NewMessage[] | undefined;
  options?: { providerAccountId?: string; threadId?: string };
  addReaction?: (
    jid: string,
    messageRef: string,
    emoji: string,
    options?: { providerAccountId?: string; threadId?: string },
  ) => Promise<void>;
}): Promise<void> {
  if (!input.addReaction || !input.messages) return;
  const target = findLatestReactionTarget(input.messages);
  if (!target) return;
  const { threadId: inheritedThreadId, ...baseOptions } = input.options ?? {};
  // The caller's thread still describes a threadless terminal row. It becomes
  // unsafe only when the scan skipped that row to select an earlier message.
  const threadId =
    target.threadId ??
    (target.messageIndex === input.messages.length - 1
      ? inheritedThreadId
      : undefined);
  const options =
    input.options || threadId
      ? {
          ...baseOptions,
          ...(threadId ? { threadId } : {}),
        }
      : undefined;
  await input.addReaction(input.jid, target.messageRef, 'seen', options);
}
