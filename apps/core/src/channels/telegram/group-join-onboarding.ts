import type { Filter } from 'grammy';

import { logger } from '../../infrastructure/logging/logger.js';
import { findConversationRoutesForChat } from '../../shared/thread-queue-key.js';
import type { ChannelOpts } from '../channel-provider.js';
import type { TelegramContext } from './channel-shared.js';

const GROUP_JOIN_CALLBACK_PATTERN = /^gjoin:(yes|no):([A-Za-z0-9-]+)$/;

type AuthorizeApprover = (
  chatId: string,
  userId: string,
  sourceAgentFolder: string,
) => Promise<boolean>;

export async function handleTelegramGroupMembershipUpdate(input: {
  ctx: Filter<TelegramContext, 'my_chat_member'>;
  opts: ChannelOpts;
  assistantName: string;
  isApproverAuthorized: AuthorizeApprover;
  sanitizeErrorMessage: (err: unknown) => string;
}): Promise<void> {
  const update = input.ctx.myChatMember;
  const chat = update.chat;
  if (chat.type !== 'group' && chat.type !== 'supergroup') return;

  const providerAccountId = input.opts.providerAccountId ?? '';
  const chatId = String(chat.id);
  const chatJid = `tg:${chatId}`;
  const title = chat.title || chatJid;
  await input.opts.onChatMetadata(
    chatJid,
    new Date(update.date * 1000).toISOString(),
    title,
    'telegram',
    true,
    { providerAccountId: input.opts.providerAccountId },
  );

  const oldStatus = update.old_chat_member.status;
  const newStatus = update.new_chat_member.status;
  if (isPresentStatus(oldStatus) && isAbsentStatus(newStatus)) {
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
  if (!isAbsentStatus(oldStatus) || !isPresentStatus(newStatus)) return;

  const registered =
    findConversationRoutesForChat(
      input.opts.conversationRoutes(),
      chatJid,
      undefined,
      input.opts.providerAccountId,
    ).length > 0;
  if (registered) return;

  const adder = String(update.from.id);
  const settings = input.opts.runtimeSettings?.();
  const contexts = settings
    ? registeredTelegramConversationContexts({
        settings,
        routes: input.opts.conversationRoutes(),
        providerAccountId,
      })
    : [];
  const adderIsKnownApprover = await anyAuthorizedContext(
    contexts.filter((context) => context.controlApprovers.includes(adder)),
    adder,
    input.isApproverAuthorized,
  );
  if (!adderIsKnownApprover) {
    logger.info(
      { provider: 'telegram', providerAccountId, chatId, chatJid, adder },
      'Telegram group join ignored: adder is not a registered control approver',
    );
    return;
  }

  const promptTarget = await firstAuthorizedControlDm(
    contexts,
    input.isApproverAuthorized,
  );
  if (!promptTarget) {
    logger.info(
      { provider: 'telegram', providerAccountId, chatId, chatJid, adder },
      'Telegram group join has no registered control DM for onboarding',
    );
    return;
  }
  if (!input.opts.groupJoinOnboarding) {
    logger.info(
      { provider: 'telegram', providerAccountId, chatId, chatJid, adder },
      'Telegram group join onboarding persistence is unavailable',
    );
    return;
  }

  const record = await input.opts.groupJoinOnboarding.recordPrompt({
    providerAccountId,
    chatJid,
    adder,
    approver: promptTarget.approver,
    promptConversationJid: promptTarget.jid,
    promptAgentFolder: promptTarget.agentFolder,
  });
  if (record.status === 'registered') return;

  const adderLabel = update.from.username
    ? `@${update.from.username}`
    : `${update.from.first_name || 'Telegram user'} (${adder})`;
  try {
    await input.ctx.api.sendMessage(
      promptTarget.jid.replace(/^tg:/, ''),
      `${adderLabel} added ${input.assistantName} to '${title}' (${chatId}). Respond there?`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Yes', callback_data: `gjoin:yes:${record.id}` },
              { text: 'No', callback_data: `gjoin:no:${record.id}` },
            ],
          ],
        },
      },
    );
  } catch (err) {
    logger.info(
      {
        provider: 'telegram',
        providerAccountId,
        chatId,
        chatJid,
        error: input.sanitizeErrorMessage(err),
      },
      'Telegram group join onboarding prompt delivery failed',
    );
  }
}

export async function handleTelegramGroupJoinCallback(input: {
  ctx: any;
  opts: ChannelOpts;
  assistantName: string;
  isApproverAuthorized: AuthorizeApprover;
  sanitizeErrorMessage: (err: unknown) => string;
}): Promise<boolean> {
  const data =
    typeof input.ctx.callbackQuery?.data === 'string'
      ? input.ctx.callbackQuery.data
      : '';
  const match = GROUP_JOIN_CALLBACK_PATTERN.exec(data);
  if (!match) return false;

  const coordinator = input.opts.groupJoinOnboarding;
  const record = coordinator ? await coordinator.getById(match[2]) : null;
  if (!record || record.status !== 'prompted') {
    await input.ctx.answerCallbackQuery({
      text: 'This onboarding request is no longer active.',
      show_alert: true,
    });
    return true;
  }

  const callbackMessage = input.ctx.callbackQuery?.message;
  const callbackChatId = String(
    callbackMessage?.chat?.id ?? input.ctx.chat?.id ?? '',
  );
  const callbackChatJid = callbackChatId ? `tg:${callbackChatId}` : '';
  const userId = String(
    input.ctx.callbackQuery?.from?.id ?? input.ctx.from?.id ?? '',
  );
  if (
    !callbackChatId ||
    callbackChatJid !== record.promptConversationJid ||
    !userId ||
    userId !== record.approver ||
    !(await input.isApproverAuthorized(
      callbackChatId,
      userId,
      record.promptAgentFolder,
    ))
  ) {
    await input.ctx.answerCallbackQuery({
      text: 'Only the selected conversation control approver can respond.',
      show_alert: true,
    });
    return true;
  }

  if (match[1] === 'no') {
    const dismissed = await coordinator!.dismiss(record.id);
    if (!dismissed) {
      await input.ctx.answerCallbackQuery({
        text: 'This onboarding request is no longer active.',
        show_alert: true,
      });
      return true;
    }
    await editCallbackMessage(input.ctx, callbackMessage, 'Not registered.');
    await input.ctx.answerCallbackQuery({ text: 'Not registered.' });
    return true;
  }

  try {
    let title = record.chatJid;
    try {
      const group = await input.ctx.api.getChat(
        record.chatJid.replace(/^tg:/, ''),
      );
      if (typeof group?.title === 'string' && group.title.trim()) {
        title = group.title;
      }
    } catch {
      // The durable JID is sufficient if Telegram cannot refresh the title.
    }
    const registered = await coordinator!.register({
      id: record.id,
      externalId: record.chatJid.replace(/^tg:/, ''),
      title,
      approvedBy: userId,
    });
    if (!registered) {
      await input.ctx.answerCallbackQuery({
        text: 'This onboarding request is no longer active.',
        show_alert: true,
      });
      return true;
    }
    const botUsername = input.ctx.me?.username || input.assistantName;
    await editCallbackMessage(
      input.ctx,
      callbackMessage,
      `Registered. Members can reach the agent with @${botUsername}. Anyone in the group can @mention; actions still need your approval.`,
    );
    await input.ctx.answerCallbackQuery({ text: 'Registered.' });
  } catch (err) {
    logger.error(
      {
        provider: 'telegram',
        providerAccountId: record.providerAccountId,
        chatJid: record.chatJid,
        error: input.sanitizeErrorMessage(err),
      },
      'Telegram group join registration failed',
    );
    await input.ctx.answerCallbackQuery({
      text: 'Could not register the group. Please try again.',
      show_alert: true,
    });
  }
  return true;
}

function isAbsentStatus(status: string): boolean {
  return status === 'left' || status === 'kicked';
}

function isPresentStatus(status: string): boolean {
  return status === 'member' || status === 'administrator';
}

interface RegisteredTelegramContext {
  jid: string;
  kind: string;
  controlApprovers: string[];
  agentFolder: string;
}

function registeredTelegramConversationContexts(input: {
  settings: NonNullable<
    ReturnType<NonNullable<ChannelOpts['runtimeSettings']>>
  >;
  routes: ReturnType<ChannelOpts['conversationRoutes']>;
  providerAccountId: string;
}): RegisteredTelegramContext[] {
  const contexts: RegisteredTelegramContext[] = [];
  for (const [, conversation] of Object.entries(
    input.settings.conversations,
  ).sort(([left], [right]) => left.localeCompare(right))) {
    if (!conversation) continue;
    const account =
      conversation.providerAccount ?? conversation.providerConnection;
    if (account !== input.providerAccountId) continue;
    const jid = `tg:${conversation.externalId.replace(/^tg:/, '')}`;
    const routes = findConversationRoutesForChat(
      input.routes,
      jid,
      undefined,
      input.providerAccountId,
    );
    for (const [, route] of routes) {
      contexts.push({
        jid,
        kind: conversation.kind,
        controlApprovers: conversation.controlApprovers ?? [],
        agentFolder: route.folder,
      });
    }
  }
  return contexts;
}

async function anyAuthorizedContext(
  contexts: RegisteredTelegramContext[],
  userId: string,
  isAuthorized: AuthorizeApprover,
): Promise<boolean> {
  for (const context of contexts) {
    if (
      await isAuthorized(
        context.jid.replace(/^tg:/, ''),
        userId,
        context.agentFolder,
      )
    ) {
      return true;
    }
  }
  return false;
}

async function firstAuthorizedControlDm(
  contexts: RegisteredTelegramContext[],
  isAuthorized: AuthorizeApprover,
): Promise<{ jid: string; agentFolder: string; approver: string } | undefined> {
  for (const context of contexts) {
    if (context.kind !== 'dm' && context.kind !== 'direct') continue;
    for (const rawApprover of context.controlApprovers) {
      const approver = rawApprover.trim();
      if (!approver) continue;
      if (
        await isAuthorized(
          context.jid.replace(/^tg:/, ''),
          approver,
          context.agentFolder,
        )
      ) {
        return { ...context, approver };
      }
    }
  }
  return undefined;
}

async function editCallbackMessage(
  ctx: any,
  message: { chat?: { id?: number | string }; message_id?: number } | undefined,
  text: string,
): Promise<void> {
  const chatId = message?.chat?.id;
  const messageId = message?.message_id;
  if (chatId === undefined || messageId === undefined) return;
  await ctx.api.editMessageText(chatId, messageId, text, {
    reply_markup: { inline_keyboard: [] },
  });
}
