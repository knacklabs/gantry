import { logger } from '../../infrastructure/logging/logger.js';

function telegramReactionEmoji(emoji: string): string {
  if (emoji === 'seen') return '👀';
  if (emoji === 'running') return '⏳';
  return emoji;
}

export async function addTelegramReaction(input: {
  bot: {
    api: {
      setMessageReaction(
        chatId: string,
        messageId: number,
        reactions: Array<{ type: 'emoji'; emoji: never }>,
        options: { is_big: boolean },
      ): Promise<unknown>;
    };
  };
  jid: string;
  messageRef: string;
  emoji: string;
  reactionKeys: Set<string>;
}): Promise<void> {
  const numericId = input.jid.replace(/^tg:/, '');
  const messageId = Number.parseInt(input.messageRef, 10);
  if (!Number.isFinite(messageId)) return;
  const reaction = telegramReactionEmoji(input.emoji);
  const key = `${input.jid}:${messageId}:${reaction}`;
  if (input.reactionKeys.has(key)) return;
  try {
    await input.bot.api.setMessageReaction(
      numericId,
      messageId,
      [{ type: 'emoji', emoji: reaction as never }],
      { is_big: false },
    );
    input.reactionKeys.add(key);
  } catch (err) {
    logger.debug(
      { jid: input.jid, messageRef: input.messageRef, err },
      'Telegram reaction update failed',
    );
  }
}

export async function removeTelegramReaction(input: {
  bot: {
    api: {
      setMessageReaction(
        chatId: string,
        messageId: number,
        reactions: [],
      ): Promise<unknown>;
    };
  };
  jid: string;
  messageRef: string;
  reactionKeys: Set<string>;
}): Promise<void> {
  const numericId = input.jid.replace(/^tg:/, '');
  const messageId = Number.parseInt(input.messageRef, 10);
  if (!Number.isFinite(messageId)) return;
  try {
    await input.bot.api.setMessageReaction(numericId, messageId, []);
    const prefix = `${input.jid}:${messageId}:`;
    for (const key of input.reactionKeys) {
      if (key.startsWith(prefix)) input.reactionKeys.delete(key);
    }
  } catch (err) {
    logger.debug(
      { jid: input.jid, messageRef: input.messageRef, err },
      'Telegram reaction removal failed',
    );
  }
}
