import { logger } from '../../infrastructure/logging/logger.js';
import { editTelegramMessage, sendTelegramMessageWithResult, } from './channel-shared.js';
import { telegramActionReplyMarkup } from './message-action-affordances.js';
export function progressActionOptions(options) {
    const actionReplyMarkup = options.actionAffordances
        ? telegramActionReplyMarkup(options.actionAffordances)
        : undefined;
    return {
        sendOptions: actionReplyMarkup ? { reply_markup: actionReplyMarkup } : {},
        editReplyMarkup: actionReplyMarkup
            ? { reply_markup: actionReplyMarkup }
            : options.done
                ? { reply_markup: { inline_keyboard: [] } }
                : {},
    };
}
export function prepareTelegramProgressHandle(input) {
    let existing = input.existing;
    if (existing &&
        (existing.chatId !== input.chatId || existing.threadId !== input.threadId)) {
        logger.warn({
            jid: input.jid,
            key: input.key,
            storedChatId: existing.chatId,
            storedThreadId: existing.threadId,
            expectedChatId: input.chatId,
            expectedThreadId: input.threadId,
        }, 'Progress lifecycle telegram dropped mismatched persisted handle');
        input.activeProgressMessages.delete(input.key);
        input.persistProgressMessages();
        existing = undefined;
    }
    if (!existing ||
        input.options.generation === undefined ||
        existing.generation === undefined ||
        existing.generation === input.options.generation) {
        return { accepted: true, existing };
    }
    if (input.options.generation < existing.generation) {
        if (existing.restored &&
            !input.options.done &&
            !input.options.replaceOnly) {
            logger.info({
                jid: input.jid,
                key: input.key,
                generation: input.options.generation,
                existingGeneration: existing.generation,
            }, 'Progress lifecycle telegram replacing restored generation');
            input.activeProgressMessages.delete(input.key);
            input.persistProgressMessages();
            return { accepted: true };
        }
        logger.info({
            jid: input.jid,
            key: input.key,
            done: input.options.done ?? false,
            replaceOnly: input.options.replaceOnly ?? false,
            generation: input.options.generation,
            existingGeneration: existing.generation,
        }, 'Progress lifecycle telegram dropped generation mismatch');
        return { accepted: false, existing };
    }
    if (!input.options.done && !input.options.replaceOnly) {
        logger.info({
            jid: input.jid,
            key: input.key,
            done: input.options.done ?? false,
            generation: input.options.generation,
            existingGeneration: existing.generation,
        }, 'Progress lifecycle telegram generation rollover');
        input.activeProgressMessages.delete(input.key);
        input.persistProgressMessages();
        existing = undefined;
    }
    return { accepted: true, existing };
}
export async function clearProgressActions(input) {
    if (!input.messageId)
        return;
    await editTelegramMessage(input.api, input.chatId, input.messageId, input.text, {}, input.editReplyMarkup);
}
export async function sendNewProgressMessage(input) {
    const messageId = await sendTelegramMessageWithResult(input.api, input.chatId, input.text, input.sendOptions);
    if (!input.options.done) {
        input.activeProgressMessages.set(input.key, {
            chatId: String(input.chatId),
            threadId: input.threadId,
            messageId,
            lastText: input.text,
            ...(input.options.generation !== undefined
                ? { generation: input.options.generation }
                : {}),
        });
        input.persistProgressMessages();
    }
    logger.info({
        jid: input.jid,
        key: input.key,
        progressText: input.text,
        done: input.options.done ?? false,
        generation: input.options.generation,
        messageId,
        storedHandle: !input.options.done,
    }, 'Progress lifecycle telegram sent new message');
}
