import type { Api } from 'grammy';
import type {
  MessageDeliveryResult,
  MessageSendOptions,
} from '../../domain/types.js';
import {
  jobPermissionCardRevision,
  type JobPermissionCardDeliverySettlement,
} from '../interaction-settlement.js';
import { telegramActionReplyMarkup } from './message-action-affordances.js';
import type { telegramThreadOptionsFromString } from './channel-shared.js';

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
  return deliveries.serialize(revision.callbackKey, async () => {
    const settled = deliveries.settledMessageId(revision);
    if (settled) return delivered(settled);
    // The card this instance already sent is authoritative; the caller's
    // persisted id only recovers a card sent before a restart.
    const replaceMessageId =
      deliveries.previousMessageId(revision) ?? options.replaceMessageId;
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
