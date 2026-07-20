import type { Filter } from 'grammy';

import { logger } from '../../infrastructure/logging/logger.js';
import { findConversationRoutesForChat } from '../../shared/thread-queue-key.js';
import type { ChannelOpts } from '../channel-provider.js';
import type { TelegramContext } from './channel-shared.js';
import { shouldLogUnregisteredChatDrop } from '../unregistered-chat-drop-log.js';

const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping']);

export async function handleTelegramTextMessage(input: {
  ctx: Filter<TelegramContext, 'message:text'>;
  opts: ChannelOpts;
  assistantName: string;
  triggerPattern: RegExp;
  tryResolveOther: (input: {
    chatId: string;
    replyToMessageId: number;
    text: string;
    userId: string;
    answeredBy: string;
  }) => Promise<boolean>;
}): Promise<void> {
  const { ctx } = input;
  if (ctx.message.text.startsWith('/')) {
    const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
    if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
  }

  const chatJid = `tg:${ctx.chat.id}`;
  let content = ctx.message.text;
  const timestamp = new Date(ctx.message.date * 1000).toISOString();
  const senderName =
    ctx.from?.first_name ||
    ctx.from?.username ||
    ctx.from?.id.toString() ||
    'Unknown';
  const sender = ctx.from?.id.toString() || '';
  const msgId = ctx.message.message_id.toString();
  const threadId = ctx.message.message_thread_id;

  const replyTo = ctx.message.reply_to_message;
  const replyToMessageId = replyTo?.message_id?.toString();
  const replyToContent = replyTo?.text || replyTo?.caption;
  const replyToSenderName = replyTo
    ? replyTo.from?.first_name ||
      replyTo.from?.username ||
      replyTo.from?.id?.toString() ||
      'Unknown'
    : undefined;

  if (typeof replyTo?.message_id === 'number') {
    const handledOther = await input.tryResolveOther({
      chatId: ctx.chat.id.toString(),
      replyToMessageId: replyTo.message_id,
      text: ctx.message.text,
      userId: sender,
      answeredBy: senderName,
    });
    if (handledOther) return;
  }

  const chatName =
    ctx.chat.type === 'private'
      ? senderName
      : (ctx.chat as { title?: string }).title || chatJid;

  const botUsername = ctx.me?.username?.toLowerCase();
  if (botUsername) {
    const entities = ctx.message.entities || [];
    const isBotMentioned = entities.some((entity) => {
      if (entity.type === 'mention') {
        const mentionText = content
          .substring(entity.offset, entity.offset + entity.length)
          .toLowerCase();
        return mentionText === `@${botUsername}`;
      }
      return false;
    });
    if (isBotMentioned && !input.triggerPattern.test(content)) {
      content = `@${input.assistantName} ${content}`;
    }
  }

  const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
  await input.opts.onChatMetadata(
    chatJid,
    timestamp,
    chatName,
    'telegram',
    isGroup,
    { providerAccountId: input.opts.providerAccountId },
  );

  const hasRegisteredRoute =
    findConversationRoutesForChat(
      input.opts.conversationRoutes(),
      chatJid,
      threadId?.toString(),
    ).length > 0;
  if (!hasRegisteredRoute && isGroup) {
    if (shouldLogUnregisteredChatDrop('telegram', chatJid)) {
      logger.info(
        {
          provider: 'telegram',
          providerAccountId: input.opts.providerAccountId,
          chatId: String(ctx.chat.id),
          chatJid,
          chatName,
        },
        'Message from unregistered Telegram chat',
      );
    }
    return;
  }

  await input.opts.onMessage(chatJid, {
    id: msgId,
    chat_jid: chatJid,
    provider: 'telegram',
    providerAccountId: input.opts.providerAccountId,
    sender,
    sender_name: senderName,
    content,
    timestamp,
    is_from_me: false,
    external_message_id: msgId,
    thread_id: threadId ? threadId.toString() : undefined,
    reply_to_message_id: replyToMessageId,
    reply_to_message_content: replyToContent,
    reply_to_sender_name: replyToSenderName,
  });

  logger.info(
    { chatJid, chatName, sender: senderName },
    'Telegram message stored',
  );
}
