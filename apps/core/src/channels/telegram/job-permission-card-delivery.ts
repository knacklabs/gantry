import type { Api } from 'grammy';
import type {
  MessageDeliveryResult,
  MessageSendOptions,
} from '../../domain/types.js';
import { logger } from '../../infrastructure/logging/logger.js';
import {
  jobPermissionCardRevision,
  type JobPermissionCardDeliverySettlement,
} from '../interaction-settlement.js';
import { telegramActionReplyMarkup } from './message-action-affordances.js';
import type { telegramThreadOptionsFromString } from './channel-shared.js';
import { escapeTelegramHtml } from './html-render.js';

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
  const revision = {
    ...cardRevision,
    callbackKey: `${chatId}:${cardRevision.callbackKey}`,
  };
  const delivered = (
    externalMessageId: string,
    retireDelivery?: NonNullable<
      MessageDeliveryResult['jobPermissionCardRetireDelivery']
    >,
  ): MessageDeliveryResult => ({
    externalMessageId,
    externalMessageIds: [externalMessageId],
    deliveredParts: 1,
    totalParts: 1,
    ...(retireDelivery
      ? { jobPermissionCardRetireDelivery: retireDelivery }
      : {}),
  });
  const persisted = cardRevision.retireDelivery;
  if (persisted?.deletedAt || persisted?.receiptMessageId) {
    const settledMessageId = persisted.receiptMessageId ?? deleteMessageId;
    deliveries.record(
      revision,
      settledMessageId,
      `${chatId}:${deleteMessageId}`,
    );
    return delivered(settledMessageId, persisted);
  }
  deliveries.bindMessage(`${chatId}:${deleteMessageId}`, revision.callbackKey);
  return deliveries.serialize(revision.callbackKey, async () => {
    const settled = deliveries.settledMessageId(revision);
    if (settled) return delivered(settled);
    let retireDelivery: NonNullable<
      MessageDeliveryResult['jobPermissionCardRetireDelivery']
    >;
    try {
      await api.deleteMessage(chatId, messageId);
      retireDelivery = { deletedAt: new Date().toISOString() };
    } catch (err) {
      logger.debug(
        {
          chatId,
          messageId: deleteMessageId,
          error: sanitizeErrorMessage(err),
        },
        'Failed to delete approved Telegram job permission card; editing fallback receipt',
      );
      await api.editMessageText(chatId, messageId, escapeTelegramHtml(text), {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [] },
      });
      retireDelivery = { receiptMessageId: deleteMessageId };
    }
    deliveries.record(
      revision,
      deleteMessageId,
      `${chatId}:${deleteMessageId}`,
    );
    return delivered(deleteMessageId, retireDelivery);
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
