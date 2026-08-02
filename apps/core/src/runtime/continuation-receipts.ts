import type { NewMessage } from '../domain/types.js';

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
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const ref = input.messages[index]?.external_message_id;
    if (!ref || ref.startsWith('external-ingress:')) continue;
    await input.addReaction(input.jid, ref, 'seen', input.options);
    return;
  }
}
