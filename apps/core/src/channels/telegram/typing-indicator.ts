import type { AbortSignal as GrammyAbortSignal } from 'abort-controller';
import { translateTelegramLiveUxError } from './live-ux.js';

export async function sendTelegramTyping(input: {
  bot: {
    api: {
      sendChatAction: (
        chatId: string,
        action: 'typing',
        options?: undefined,
        signal?: GrammyAbortSignal,
      ) => Promise<unknown>;
    };
  } | null;
  jid: string;
  isTyping: boolean;
  signal?: AbortSignal;
}): Promise<void> {
  if (!input.bot || !input.isTyping) return;
  try {
    await input.bot.api.sendChatAction(
      input.jid.replace(/^tg:/, ''),
      'typing',
      undefined,
      input.signal as unknown as GrammyAbortSignal | undefined,
    );
  } catch (err) {
    translateTelegramLiveUxError(err);
  }
}
