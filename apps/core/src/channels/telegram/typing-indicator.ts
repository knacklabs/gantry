import type { AbortSignal as GrammyAbortSignal } from 'abort-controller';
import { translateTelegramLiveUxError } from './live-ux.js';

export async function sendTelegramTyping(input: {
  bot: {
    api: {
      sendChatAction: (
        chatId: string,
        action: 'typing',
        options?: { message_thread_id?: number },
        signal?: GrammyAbortSignal,
      ) => Promise<unknown>;
    };
  } | null;
  jid: string;
  isTyping: boolean;
  threadId?: string;
  signal?: AbortSignal;
}): Promise<void> {
  if (!input.bot || !input.isTyping) return;
  const threadId = input.threadId
    ? Number.parseInt(input.threadId, 10)
    : undefined;
  try {
    await input.bot.api.sendChatAction(
      input.jid.replace(/^tg:/, ''),
      'typing',
      Number.isFinite(threadId) ? { message_thread_id: threadId } : undefined,
      input.signal as unknown as GrammyAbortSignal | undefined,
    );
  } catch (err) {
    translateTelegramLiveUxError(err);
  }
}
