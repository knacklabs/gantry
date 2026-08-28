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

type RetireDelivery = NonNullable<
  MessageDeliveryResult['jobPermissionCardRetireDelivery']
>;

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
    if (settled) {
      const retireDelivery = persisted?.deleteFailedAt
        ? {
            deleteFailedAt: persisted.deleteFailedAt,
            receiptMessageId: deleteMessageId,
          }
        : { deletedAt: new Date().toISOString() };
      return delivered(settled, retireDelivery);
    }
    let retireDelivery: RetireDelivery;
    if (persisted?.deleteFailedAt) {
      try {
        await api.editMessageText(chatId, messageId, escapeTelegramHtml(text), {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [] },
        });
      } catch (err) {
        throw partialFallback(err, persisted.deleteFailedAt);
      }
      retireDelivery = {
        deleteFailedAt: persisted.deleteFailedAt,
        receiptMessageId: deleteMessageId,
      };
    } else {
      try {
        await api.deleteMessage(chatId, messageId);
      } catch (err) {
        const deleteFailedAt = new Date().toISOString();
        logger.debug(
          {
            chatId,
            messageId: deleteMessageId,
            error: sanitizeErrorMessage(err),
          },
          'Failed to delete approved Telegram job permission card; receipt edit queued',
        );
        throw partialFallback(err, deleteFailedAt);
      }
      retireDelivery = { deletedAt: new Date().toISOString() };
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
