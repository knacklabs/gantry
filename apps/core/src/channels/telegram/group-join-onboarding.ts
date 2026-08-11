import type { Filter } from 'grammy';

import { logger } from '../../infrastructure/logging/logger.js';
import type { ChannelOpts } from '../channel-provider.js';
import { bootstrapGroupInstall } from '../group-install-bootstrap.js';
import type { TelegramContext } from './channel-shared.js';

export async function handleTelegramGroupMembershipUpdate(input: {
  ctx: Filter<TelegramContext, 'my_chat_member'>;
  opts: ChannelOpts;
}): Promise<void> {
  const update = input.ctx.myChatMember;
  const chat = update.chat;
  if (chat.type !== 'group' && chat.type !== 'supergroup') return;

  const providerAccountId = input.opts.providerAccountId ?? '';
  const chatId = String(chat.id);
  const chatJid = `tg:${chatId}`;
  const title = chat.title || chatJid;

  const oldMember = update.old_chat_member;
  const newMember = update.new_chat_member;
  if (isPresentStatus(oldMember) && isAbsentStatus(newMember)) {
    await input.opts.onChatMetadata(
      chatJid,
      new Date(update.date * 1000).toISOString(),
      title,
      'telegram',
      true,
      { providerAccountId: input.opts.providerAccountId },
    );
    logger.info(
      { provider: 'telegram', providerAccountId, chatId, chatJid },
      'Telegram bot left a group',
    );
    // TODO(group-onboarding-v2): settings cleanup on kick/left is intentionally
    // out of scope for v1; preserve the registered conversation.
    await input.opts.groupJoinOnboarding?.markLeft({
      providerAccountId,
      chatJid,
    });
    return;
  }
  if (!isAbsentStatus(oldMember) || !isPresentStatus(newMember)) return;

  await bootstrapGroupInstall({
    opts: input.opts,
    provider: 'telegram',
    providerAccountId,
    chatJid,
    title,
    installerExternalId: String(update.from.id),
    send: (text) => input.ctx.api.sendMessage(chat.id, text),
  });
}

interface TelegramChatMemberState {
  status: string;
  is_member?: boolean;
}

function isAbsentStatus(member: TelegramChatMemberState): boolean {
  return (
    member.status === 'left' ||
    member.status === 'kicked' ||
    // A restricted member with is_member false has been removed.
    (member.status === 'restricted' && member.is_member === false)
  );
}

function isPresentStatus(member: TelegramChatMemberState): boolean {
  return (
    member.status === 'member' ||
    member.status === 'administrator' ||
    // Telegram reports a bot added with restrictions as status 'restricted'
    // with is_member true - it is present and onboarding must fire.
    (member.status === 'restricted' && member.is_member !== false)
  );
}
