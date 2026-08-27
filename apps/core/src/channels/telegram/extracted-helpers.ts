import type {
  MessageDeliveryResult,
  MessageSendOptions,
} from '../../domain/types.js';
import { PartialMessageDeliveryError } from '../../domain/messages/partial-delivery.js';
import { logger } from '../../infrastructure/logging/logger.js';
import {
  TELEGRAM_MESSAGE_MAX_LENGTH,
  TELEGRAM_STREAM_CHUNK_MAX_LENGTH,
  escapeTelegramMarkdownV2,
  splitTelegramDeliveryText,
  type ActiveProgressState,
  type TelegramSendMessageOptions,
} from './channel-shared.js';
import { appendTelegramDocumentMessageIds } from './file-delivery.js';
import { telegramActionReplyMarkup } from './message-action-affordances.js';
import { unescapeTelegramEscapedMarkdownV2 } from './markdown-v2-unescape.js';
import { clearProgressActions } from './progress-message-actions.js';
import { sendTelegramPlannedChunk } from './send-planned-chunk.js';

type TelegramDeliveryApi = Parameters<typeof sendTelegramPlannedChunk>[0] &
  Parameters<typeof appendTelegramDocumentMessageIds>[1];

export async function clearRestoredTelegramProgressActions(input: {
  activeProgressMessages: Map<string, ActiveProgressState>;
  api: Parameters<typeof clearProgressActions>[0]['api'];
  sanitizeErrorMessage: (err: unknown) => string;
}): Promise<void> {
  for (const [key, state] of input.activeProgressMessages.entries()) {
    if (!state.restored || !state.messageId) continue;
    await clearProgressActions({
      api: input.api,
      chatId: state.chatId,
      messageId: state.messageId,
      text: state.lastText,
      editReplyMarkup: { reply_markup: { inline_keyboard: [] } },
    }).catch((err) =>
      logger.debug(
        { key, err: input.sanitizeErrorMessage(err) },
        'Failed to clear restored Telegram progress actions',
      ),
    );
  }
}

export async function sendTelegramDeliveryChunks(input: {
  api: TelegramDeliveryApi;
  chatId: string;
  jid: string;
  options: MessageSendOptions;
  sendOptions: TelegramSendMessageOptions;
  text: string;
}): Promise<MessageDeliveryResult> {
  // Split after escaping so each outbound envelope already matches the
  // exact payload Telegram receives.
  const escapedText = escapeTelegramMarkdownV2(input.text, {
    preserveStyleMarkers: true,
  });
  const escapedChunks = splitTelegramDeliveryText(
    escapedText,
    TELEGRAM_STREAM_CHUNK_MAX_LENGTH,
    TELEGRAM_MESSAGE_MAX_LENGTH,
  );
  const chunks = escapedChunks.map((escapedChunk) => ({
    escapedText: escapedChunk,
    canonicalText: unescapeTelegramEscapedMarkdownV2(escapedChunk),
  }));
  if (chunks.length === 0) return {};

  const warnings: string[] = [];
  if (chunks.length > 1) {
    warnings.push(
      `telegram.message.chunked:${chunks.length}:${TELEGRAM_STREAM_CHUNK_MAX_LENGTH}`,
    );
  }

  const externalMessageIds: string[] = [];
  let deliveredChunks = 0;
  let usePlainText = false;
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const chunk = chunks[chunkIndex];
    const replyMarkup =
      chunkIndex === chunks.length - 1
        ? telegramActionReplyMarkup(input.options.actionAffordances)
        : undefined;
    try {
      const sent = await sendTelegramPlannedChunk(
        input.api,
        input.chatId,
        chunk.escapedText,
        {
          sendOptions: (replyMarkup
            ? { ...input.sendOptions, reply_markup: replyMarkup }
            : input.sendOptions) as NonNullable<
            Parameters<typeof sendTelegramPlannedChunk>[3]
          >['sendOptions'],
          plainText: chunk.canonicalText,
          allowPlainTextFallback: !usePlainText,
          forcePlainText: usePlainText,
        },
      );
      usePlainText = sent.usedPlainText || usePlainText;
      if (sent.messageId !== undefined) {
        externalMessageIds.push(String(sent.messageId));
      }
      deliveredChunks += 1;
    } catch (err) {
      if (deliveredChunks > 0) {
        const unsentCanonicalTail = chunks
          .slice(deliveredChunks)
          .map((planned) => planned.canonicalText)
          .join('');
        const partial = new PartialMessageDeliveryError({
          cause: err,
          deliveredChunks,
          name: 'PartialTelegramDeliveryError',
          message: `Telegram message partially delivered (${deliveredChunks}/${chunks.length} chunks)`,
          totalChunks: chunks.length,
        });
        Object.assign(partial, {
          provider: 'telegram',
          deliveredParts: deliveredChunks,
          totalParts: chunks.length,
          externalMessageIds,
          ...(unsentCanonicalTail.trim()
            ? {
                retryTail: {
                  canonicalText: unsentCanonicalTail,
                  providerPayload: {
                    provider: 'telegram',
                    chatId: input.chatId,
                    ...(input.options.threadId
                      ? { threadId: input.options.threadId }
                      : {}),
                  },
                },
              }
            : {}),
          ...(warnings.length > 0 ? { warnings } : {}),
        });
        throw partial;
      }
      throw err;
    }
  }
  await appendTelegramDocumentMessageIds(
    externalMessageIds,
    input.api,
    input.chatId,
    input.options,
  );
  logger.info(
    {
      jid: input.jid,
      length: input.text.length,
      threadId: input.options.threadId,
    },
    'Telegram message sent',
  );
  return {
    ...(externalMessageIds[0]
      ? { externalMessageId: externalMessageIds[0] }
      : {}),
    ...(externalMessageIds.length > 0 ? { externalMessageIds } : {}),
    deliveredParts: deliveredChunks,
    totalParts: chunks.length,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}
