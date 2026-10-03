import type { Filter } from 'grammy';

import { logger } from '../../infrastructure/logging/logger.js';
import { findConversationRoutesForChat } from '../../shared/thread-queue-key.js';
import type { ChannelOpts } from '../channel-provider.js';
import { resolveInboundConversationIdentityForChat } from '../inbound-conversation-identity.js';
import type { TelegramContext } from './channel-shared.js';
import { shouldLogUnregisteredChatDrop } from '../unregistered-chat-drop-log.js';

const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping']);

type TelegramEntity = {
  type: string;
  offset: number;
  length: number;
  user?: { id: number };
};

type TelegramUser = { id: number; first_name?: string; username?: string };

/** True when Telegram marks this bot as mentioned in the text or caption. */
function telegramMentionsBot(input: {
  text: string;
  entities?: readonly TelegramEntity[];
  me?: { id?: number; username?: string };
}): boolean {
  const botUsername = input.me?.username?.toLowerCase();
  return (input.entities ?? []).some((entity) =>
    entity.type === 'text_mention'
      ? entity.user?.id !== undefined && entity.user.id === input.me?.id
      : entity.type === 'mention' &&
        !!botUsername &&
        input.text
          .substring(entity.offset, entity.offset + entity.length)
          .toLowerCase() === `@${botUsername}`,
  );
}

/**
 * The fields every Telegram inbound message carries, text and media alike.
 * A route's own name trigger is the policy's job; this flags only a native
 * mention of this bot.
 */
export function telegramInboundEnvelope(ctx: {
  from?: TelegramUser;
  me?: { id?: number; username?: string };
  message: {
    message_id: number;
    date: number;
    message_thread_id?: number;
    text?: string;
    caption?: string;
    entities?: readonly TelegramEntity[];
    caption_entities?: readonly TelegramEntity[];
    reply_to_message?: {
      message_id: number;
      text?: string;
      caption?: string;
      from?: TelegramUser;
    };
  };
}) {
  const { message } = ctx;
  const id = message.message_id.toString();
  const replyTo = message.reply_to_message;
  const text = message.text ?? message.caption;
  return {
    id,
    sender: ctx.from?.id.toString() || '',
    sender_name:
      ctx.from?.first_name ||
      ctx.from?.username ||
      ctx.from?.id.toString() ||
      'Unknown',
    timestamp: new Date(message.date * 1000).toISOString(),
    is_from_me: false,
    external_message_id: id,
    thread_id: message.message_thread_id?.toString(),
    reply_to_message_id: replyTo?.message_id.toString(),
    reply_to_message_content: replyTo?.text || replyTo?.caption,
    reply_to_sender_name: replyTo
      ? replyTo.from?.first_name ||
        replyTo.from?.username ||
        replyTo.from?.id.toString() ||
        'Unknown'
      : undefined,
    ...(text &&
    telegramMentionsBot({
      text,
      entities: message.text ? message.entities : message.caption_entities,
      me: ctx.me,
    })
      ? { mentionsBot: true }
      : {}),
  };
}

export async function handleTelegramTextMessage(input: {
  ctx: Filter<TelegramContext, 'message:text'>;
  opts: ChannelOpts;
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
  const envelope = telegramInboundEnvelope(ctx);
  const { sender, sender_name: senderName, timestamp } = envelope;
  const threadId = ctx.message.message_thread_id;
  const replyTo = ctx.message.reply_to_message;

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

  const isGroup = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
  // Two different questions, deliberately answered with two different lookups.
  //
  // DELIVERY (below): unscoped, exactly as before. A route configured without a
  // providerAccountId still routes messages, and narrowing this would start
  // dropping group messages that used to be delivered.
  const hasRegisteredRoute =
    findConversationRoutesForChat(
      input.opts.conversationRoutes(),
      chatJid,
      threadId?.toString(),
    ).length > 0;
  // METADATA: account-scoped. Two accounts can share a chat JID; an unscoped
  // match would see ANOTHER account's route, skip this account's metadata
  // write, and then have its message rejected by account-scoped persistence —
  // losing both the conversation row and the envelope. Scoping errs toward
  // writing metadata, which is the safe direction.
  const identity = resolveInboundConversationIdentityForChat({
    conversationRoutes: input.opts.conversationRoutes(),
    chatJid,
    threadId: threadId?.toString(),
    providerAccountId: input.opts.providerAccountId,
    name: chatName,
    isGroup,
  });
  if (identity.needsStandaloneMetadataWrite) {
    await input.opts.onChatMetadata(
      chatJid,
      timestamp,
      chatName,
      'telegram',
      isGroup,
      { providerAccountId: input.opts.providerAccountId },
    );
  }
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
    ...envelope,
    chat_jid: chatJid,
    ...identity.messageIdentity,
    provider: 'telegram',
    content: ctx.message.text,
  });

  logger.info(
    { chatJid, chatName, sender: senderName },
    'Telegram message stored',
  );
}
