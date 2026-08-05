import type { NewMessage } from '../domain/types.js';

export function latestReactionTarget(
  messages: readonly NewMessage[] | undefined,
): { messageRef: string; threadId?: string } | undefined {
  if (!messages) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const messageRef = message?.external_message_id;
    if (messageRef && !messageRef.startsWith('external-ingress:')) {
      return {
        messageRef,
        ...(message.thread_id ? { threadId: message.thread_id } : {}),
      };
    }
  }
  return undefined;
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
  const target = latestReactionTarget(input.messages);
  if (!target) return;
  const { threadId: _inheritedThreadId, ...baseOptions } = input.options ?? {};
  const options =
    input.options || target.threadId
      ? {
          ...baseOptions,
          ...(target.threadId ? { threadId: target.threadId } : {}),
        }
      : undefined;
  await input.addReaction(input.jid, target.messageRef, 'seen', options);
}
