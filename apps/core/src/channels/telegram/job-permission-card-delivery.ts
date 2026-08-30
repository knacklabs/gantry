import type { Api } from 'grammy';
import type {
  MessageDeliveryResult,
  MessageSendOptions,
} from '../../domain/types.js';
import { PartialMessageDeliveryError } from '../../domain/messages/partial-delivery.js';
import { logger } from '../../infrastructure/logging/logger.js';
import {
  jobPermissionCardRevision,
  type JobPermissionCardDeliverySettlement,
} from '../interaction-settlement.js';
import { telegramActionReplyMarkup } from './message-action-affordances.js';
import type { telegramThreadOptionsFromString } from './channel-shared.js';
import { escapeTelegramHtml } from './html-render.js';
import { settleJobPermissionCardRetire } from '../job-permission-card-settlement.js';

export async function retireTelegramJobPermissionCard({
  api,
  chatId,
  text,
  options,
  deliveries,
  sanitizeErrorMessage,
}: {
  api: Api;
  chatId: string;
  text: string;
  options: MessageSendOptions;
  deliveries: JobPermissionCardDeliverySettlement;
  sanitizeErrorMessage: (error: unknown) => string;
}): Promise<MessageDeliveryResult> {
  const deleteMessageId = options.deleteMessageId;
  const messageId = Number.parseInt(deleteMessageId ?? '', 10);
  const cardRevision = options.jobPermissionCardRevision;
  if (!deleteMessageId || !Number.isSafeInteger(messageId)) {
    throw new Error('Telegram deletion message id is invalid.');
  }
  if (
    !cardRevision ||
    cardRevision.operation !== 'retire' ||
    cardRevision.retireOutcome !== 'allowed'
  ) {
    throw new Error(
      'Telegram job permission card deletion has no allowed retire revision.',
    );
  }
  const partialFallback = (cause: unknown, deleteFailedAt: string) => {
    const partial = new PartialMessageDeliveryError({
      cause,
      deliveredChunks: 1,
      name: 'PartialTelegramJobPermissionCardRetireError',
      message: 'Telegram card delete failed; receipt edit remains pending',
      totalChunks: 2,
    });
    Object.assign(partial, {
      provider: 'telegram',
      deliveredParts: 1,
      totalParts: 2,
      externalMessageIds: [deleteMessageId],
      retryTail: {
        canonicalText: text,
        providerPayload: {
          jobPermissionCard: {
            ...cardRevision,
            providerMessageId: deleteMessageId,
            retireDelivery: { deleteFailedAt },
            actions: [],
          },
        },
      },
    });
    return partial;
  };
  return settleJobPermissionCardRetire({
    deliveries,
    scope: chatId,
    providerMessageId: deleteMessageId,
    options,
    deleteMessage: () => api.deleteMessage(chatId, messageId).then(() => {}),
    deliverReceipt: async () => {
      await api.editMessageText(chatId, messageId, escapeTelegramHtml(text), {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [] },
      });
      return deleteMessageId;
    },
    onDeleteFailure: (err, deleteFailedAt) => {
      logger.debug(
        {
          chatId,
          messageId: deleteMessageId,
          error: sanitizeErrorMessage(err),
        },
        'Failed to delete approved Telegram job permission card; receipt edit queued',
      );
      throw partialFallback(err, deleteFailedAt);
    },
    pendingReceiptError: partialFallback,
  });
}

export async function sendTelegramJobPermissionCard({
  api,
  chatId,
  text,
  options,
  threadOptions,
  deliveries,
}: {
  api: Api;
  chatId: string;
  text: string;
  options: MessageSendOptions;
  threadOptions: ReturnType<typeof telegramThreadOptionsFromString>;
  deliveries: JobPermissionCardDeliverySettlement;
}): Promise<MessageDeliveryResult> {
  const parsed = jobPermissionCardRevision(options.actionAffordances);
  const replyMarkup = telegramActionReplyMarkup(options.actionAffordances);
  if (!parsed || !replyMarkup) {
    throw new Error('Telegram job permission card has no valid actions.');
  }
  // Telegram message ids are chat-scoped, so settlement is too.
  const revision = {
    ...parsed,
    callbackKey: `${chatId}:${parsed.callbackKey}`,
  };
  const delivered = (externalMessageId: string): MessageDeliveryResult => ({
    externalMessageId,
    externalMessageIds: [externalMessageId],
    deliveredParts: 1,
    totalParts: 1,
  });
  // Bind a persisted (pre-restart) card message to this lane synchronously,
  // so a concurrent retire edit of that message queues behind us.
  if (options.replaceMessageId) {
    deliveries.bindMessage(
      `${chatId}:${options.replaceMessageId}`,
      revision.callbackKey,
    );
  }
  return deliveries.serialize(revision.callbackKey, async () => {
    const settled = deliveries.settledMessageId(revision);
    if (settled) return delivered(settled);
    const replaceMessageId = options.replaceMessageId;
    if (replaceMessageId) {
      const messageId = Number.parseInt(replaceMessageId, 10);
      if (!Number.isSafeInteger(messageId)) {
        throw new Error('Telegram replacement message id is invalid.');
      }
      await api.editMessageText(chatId, messageId, text, {
        parse_mode: 'HTML',
        reply_markup: replyMarkup,
      });
      deliveries.record(
        revision,
        replaceMessageId,
        `${chatId}:${replaceMessageId}`,
      );
      return delivered(replaceMessageId);
    }
    const sent = await api.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      ...threadOptions,
      reply_markup: replyMarkup,
    });
    const messageId = sent?.message_id;
    if (messageId === undefined) return {};
    const externalMessageId = String(messageId);
    deliveries.record(
      revision,
      externalMessageId,
      `${chatId}:${externalMessageId}`,
    );
    return delivered(externalMessageId);
  });
}
