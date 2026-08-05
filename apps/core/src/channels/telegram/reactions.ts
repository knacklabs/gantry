import type { AbortSignal as GrammyAbortSignal } from 'abort-controller';
import { telegramReactionEmoji } from './live-ux.js';

export async function addTelegramReaction(input: {
  bot: {
    api: {
      setMessageReaction(
        chatId: string,
        messageId: number,
        reactions: Array<{ type: 'emoji'; emoji: never }>,
        options: { is_big: boolean },
        signal?: GrammyAbortSignal,
      ): Promise<unknown>;
    };
  };
  jid: string;
  messageRef: string;
  emoji: string;
  reactionKeys: Set<string>;
  signal?: AbortSignal;
  reconcile?: boolean;
}): Promise<void> {
  const numericId = input.jid.replace(/^tg:/, '');
  const messageId = Number.parseInt(input.messageRef, 10);
  if (!Number.isFinite(messageId)) return;
  const reaction = telegramReactionEmoji(input.emoji);
  const key = `${input.jid}:${messageId}:${reaction}`;
  if (!input.reconcile && input.reactionKeys.has(key)) return;
  const prefix = `${input.jid}:${messageId}:`;
  const invalidate = () => {
    for (const cachedKey of input.reactionKeys) {
      if (cachedKey.startsWith(prefix)) input.reactionKeys.delete(cachedKey);
    }
  };
  input.signal?.addEventListener('abort', invalidate, { once: true });
  try {
    await input.bot.api.setMessageReaction(
      numericId,
      messageId,
      [{ type: 'emoji', emoji: reaction as never }],
      { is_big: false },
      input.signal as unknown as GrammyAbortSignal | undefined,
    );
    if (!input.signal?.aborted) {
      invalidate();
      input.reactionKeys.add(key);
    }
  } finally {
    input.signal?.removeEventListener('abort', invalidate);
  }
}

export async function removeTelegramReaction(input: {
  bot: {
    api: {
      setMessageReaction(
        chatId: string,
        messageId: number,
        reactions: [],
        options?: undefined,
        signal?: GrammyAbortSignal,
      ): Promise<unknown>;
    };
  };
  jid: string;
  messageRef: string;
  reactionKeys: Set<string>;
  signal?: AbortSignal;
}): Promise<void> {
  const numericId = input.jid.replace(/^tg:/, '');
  const messageId = Number.parseInt(input.messageRef, 10);
  if (!Number.isFinite(messageId)) return;
  const prefix = `${input.jid}:${messageId}:`;
  const invalidate = () => {
    for (const key of input.reactionKeys) {
      if (key.startsWith(prefix)) input.reactionKeys.delete(key);
    }
  };
  input.signal?.addEventListener('abort', invalidate, { once: true });
  try {
    await input.bot.api.setMessageReaction(
      numericId,
      messageId,
      [],
      undefined,
      input.signal as unknown as GrammyAbortSignal | undefined,
    );
    if (!input.signal?.aborted) invalidate();
  } finally {
    input.signal?.removeEventListener('abort', invalidate);
  }
}
