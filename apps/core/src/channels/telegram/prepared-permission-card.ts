import type { MessageSendOptions } from '../../domain/types.js';
import type {
  PreparedPermissionCardSend,
  PreparedPermissionCardSink,
} from '../../domain/permission-card.js';
import type { Bot } from 'grammy';
import {
  buildBoundedPermissionCard,
  permissionCardCallback,
} from '../permission-card.js';
import {
  permissionButtonLabel,
  permissionDecisionOptions,
} from '../permission-interaction.js';
import { renderPermissionPromptHtml } from './html-render.js';
import {
  telegramPermissionCallbackData,
  telegramThreadOptionsFromString,
  type TelegramContext,
} from './channel-shared.js';

export function prepareTelegramPermissionCardSend(input: {
  interactionCallbacksEnabled: boolean;
  bot: Bot<TelegramContext> | null;
  jid: string;
  options: MessageSendOptions & {
    permissionCardView: NonNullable<MessageSendOptions['permissionCardView']>;
  };
}): PreparedPermissionCardSend {
  if (!input.interactionCallbacksEnabled) {
    throw new Error(
      'This Telegram connection cannot collect approvals right now.',
    );
  }
  if (!input.bot) throw new Error('Telegram bot is not connected');
  const bot = input.bot;
  const chatId = input.jid.replace(/^tg:/, '');
  if (!chatId) {
    throw new Error('This Telegram conversation could not be identified.');
  }
  const view = input.options.permissionCardView;
  const card = buildBoundedPermissionCard(view);
  const callback = permissionCardCallback(view);
  const promptHtml = renderPermissionPromptHtml(card.parts, {
    includeFullView: Boolean(card.parts.fullView),
  });
  const replyMarkup = {
    inline_keyboard: permissionDecisionOptions(view.request).map((mode) => [
      {
        text: permissionButtonLabel(mode, view.request),
        callback_data: telegramPermissionCallbackData(
          mode,
          callback.providerAlias,
        ),
      },
    ]),
  };
  const threadOptions = telegramThreadOptionsFromString(input.options.threadId);
  return {
    send: async () => {
      const sent = await bot.api.sendMessage(chatId, promptHtml, {
        ...threadOptions,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: replyMarkup,
      });
      const messageId = String(sent.message_id);
      return {
        delivery: { externalMessageId: messageId },
        locator: {
          provider: 'telegram',
          conversationId: chatId,
          messageId,
          ...(input.options.threadId
            ? { threadId: input.options.threadId }
            : {}),
        },
      };
    },
  };
}

export function createTelegramPermissionCardPreparer(
  state: () => Pick<
    Parameters<typeof prepareTelegramPermissionCardSend>[0],
    'interactionCallbacksEnabled' | 'bot'
  >,
): PreparedPermissionCardSink['preparePermissionCardSend'] {
  return (jid, _text, options) =>
    prepareTelegramPermissionCardSend({ ...state(), jid, options });
}
