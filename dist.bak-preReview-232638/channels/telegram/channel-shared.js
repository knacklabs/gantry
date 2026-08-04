import { PERMISSION_APPROVAL_TIMEOUT_MS } from '../../config/index.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { resolveInteractionSettlementDelayMs } from '../interaction-settlement.js';
import { parseTextStyles } from '../../messaging/text-styles.js';
import { splitTelegramDeliveryTextWithLimits } from './channel-delivery-text-splitting.js';
import { escapeTelegramMarkdownV2 } from './telegram-markdown-v2-escape.js';
import { CHANNEL_STREAM_UPDATE_INTERVAL_MS } from '../channel-provider.js';
export { splitTelegramTextByCodeUnits } from './channel-delivery-text-splitting.js';
export { escapeTelegramMarkdownV2, escapeTelegramMarkdownV2CodeSegment, escapeTelegramMarkdownV2LinkSegment, escapeTelegramMarkdownV2Literal, escapeTelegramMarkdownV2Plain, } from './telegram-markdown-v2-escape.js';
export const TELEGRAM_MEDIA_DOWNLOAD_CONCURRENCY = 2;
export const TELEGRAM_MEDIA_DOWNLOAD_QUEUE_MAX = 512;
export const TELEGRAM_MEDIA_DRAIN_TIMEOUT_MS = 5000;
export const TELEGRAM_MESSAGE_MAX_LENGTH = 4096;
export const TELEGRAM_STREAM_CHUNK_MAX_LENGTH = 3500;
export const TELEGRAM_GROUP_EDIT_INTERVAL_MS = CHANNEL_STREAM_UPDATE_INTERVAL_MS.telegram;
export const TELEGRAM_INLINE_BUTTON_TEXT_MAX_BYTES = 56;
// Keep question timeout aligned with permission approvals for now.
// This can be split into a separate config knob later if UX needs diverge.
export const TELEGRAM_USER_QUESTION_TIMEOUT_MS = PERMISSION_APPROVAL_TIMEOUT_MS;
export const TELEGRAM_PERMISSION_CALLBACK_PATTERN = /^perm:(allow_once|allow_persistent_rule|cancel):([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})$/;
export const TELEGRAM_USER_QUESTION_CALLBACK_PATTERN = /^userq:(select|done|other):([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})(?::(\d+))?(?::(\d+))?$/;
export const TELEGRAM_DEAD_LETTER_ACTION_CALLBACK_PATTERN = /^dl:(retry|logs|pause|open)(?::(.+))?$/;
export function sanitizeTelegramErrorMessage(err, botToken) {
    const message = err instanceof Error
        ? err.message
        : typeof err === 'object' &&
            err !== null &&
            'message' in err &&
            typeof err.message === 'string'
            ? (err.message ?? '')
            : String(err);
    if (!message)
        return message;
    return message.split(botToken).join('[REDACTED_BOT_TOKEN]');
}
export function telegramQuestionCallbackId() {
    return `q${globalThis.crypto.randomUUID()}`;
}
export function createPendingTelegramUserQuestion(input) {
    return new Promise((resolve) => {
        const { expiresAt, permissionLane } = input.request;
        const settlementDelayMs = resolveInteractionSettlementDelayMs({
            expiresAt,
            permissionLane,
            fallbackTimeoutMs: input.timeoutMs,
        });
        const timer = settlementDelayMs !== undefined
            ? setTimeout(() => {
                const timedOut = input.pendingQuestions.get(input.pendingKey);
                if (!timedOut)
                    return;
                // Fire-and-forget is intentional: timer callbacks must not block cleanup.
                void input.finalize(timedOut, timedOut.multiSelect ? [] : '', 'system', 'timed out');
            }, settlementDelayMs)
            : undefined;
        input.pendingQuestions.set(input.pendingKey, {
            callbackId: input.callbackId,
            appId: input.request.appId || 'default',
            requestId: input.request.requestId,
            sourceAgentFolder: input.request.sourceAgentFolder,
            questionIndex: input.questionIndex,
            questionHeader: input.question.header,
            questionText: input.question.question,
            promptText: input.promptText,
            promptIsHtml: input.promptIsHtml,
            optionLabels: input.question.options.map((option) => option.label),
            multiSelect: input.question.multiSelect,
            selectedOptionIndexes: new Set(),
            chatId: input.chatId,
            messageId: input.messageId,
            timer,
            resolve,
        });
        input.callbacks.set(input.callbackId, {
            appId: input.request.appId || 'default',
            sourceAgentFolder: input.request.sourceAgentFolder,
            requestId: input.request.requestId,
            questionIndex: input.questionIndex,
        });
    });
}
export function splitTelegramDeliveryText(text, softCodeUnitBudget = TELEGRAM_STREAM_CHUNK_MAX_LENGTH, hardCodeUnitLimit = TELEGRAM_MESSAGE_MAX_LENGTH) {
    return splitTelegramDeliveryTextWithLimits(text, softCodeUnitBudget, hardCodeUnitLimit);
}
export function truncateText(text, maxLen) {
    if (text.length <= maxLen)
        return text;
    return `${text.slice(0, maxLen)}...`;
}
export function telegramThreadOptionsFromString(threadId) {
    if (!threadId)
        return {};
    if (!/^\d+$/.test(threadId))
        return {};
    const parsedThreadId = Number.parseInt(threadId, 10);
    return Number.isSafeInteger(parsedThreadId) && parsedThreadId > 0
        ? { message_thread_id: parsedThreadId }
        : {};
}
export function truncateUtf8ToByteLimit(text, maxBytes) {
    if (Buffer.byteLength(text, 'utf8') <= maxBytes)
        return text;
    const suffix = '...';
    const suffixBytes = Buffer.byteLength(suffix, 'utf8');
    if (maxBytes <= suffixBytes)
        return suffix.slice(0, maxBytes);
    let out = '';
    for (const char of text) {
        const next = out + char;
        if (Buffer.byteLength(next, 'utf8') + suffixBytes > maxBytes)
            break;
        out = next;
    }
    return `${out}${suffix}`;
}
export function stripInternalTagsPreserveWhitespace(text) {
    return text.replace(/<internal>[\s\S]*?<\/internal>/g, '');
}
export function formatTelegramStreamingText(rawText, done) {
    const text = stripInternalTagsPreserveWhitespace(rawText);
    if (!text)
        return '';
    return done ? parseTextStyles(text, 'telegram-html') : text;
}
/**
 * Send a message with Telegram MarkdownV2, then plain text.
 */
export async function sendTelegramMessage(api, chatId, text, options = {}) {
    await sendTelegramMessageWithResult(api, chatId, text, options);
}
export async function sendTelegramMessageWithResult(api, chatId, text, options = {}, escapeOptions = {}) {
    try {
        const sent = await api.sendMessage(chatId, text, {
            ...options,
            parse_mode: 'MarkdownV2',
        });
        return sent?.message_id;
    }
    catch (errV2Raw) {
        logger.debug({ err: errV2Raw }, 'MarkdownV2 send failed, retrying with escaped text');
    }
    try {
        const sent = await api.sendMessage(chatId, escapeTelegramMarkdownV2(text, escapeOptions), {
            ...options,
            parse_mode: 'MarkdownV2',
        });
        return sent?.message_id;
    }
    catch (errV2Escaped) {
        logger.debug({ err: errV2Escaped }, 'Escaped MarkdownV2 send failed, falling back to plain text');
    }
    const sent = await api.sendMessage(chatId, text, options);
    return sent?.message_id;
}
export async function editTelegramMessage(api, chatId, messageId, text, escapeOptions = {}, editOptions = {}) {
    try {
        await api.editMessageText(chatId, messageId, text, {
            parse_mode: 'MarkdownV2',
            ...editOptions,
        });
        return;
    }
    catch (errV2Raw) {
        const msg = errV2Raw instanceof Error ? errV2Raw.message : String(errV2Raw);
        if (/message is not modified/i.test(msg))
            return;
        logger.debug({ err: errV2Raw }, 'MarkdownV2 edit failed, retrying with escaped text');
    }
    try {
        await api.editMessageText(chatId, messageId, escapeTelegramMarkdownV2(text, escapeOptions), {
            parse_mode: 'MarkdownV2',
            ...editOptions,
        });
        return;
    }
    catch (errV2Escaped) {
        const msg = errV2Escaped instanceof Error
            ? errV2Escaped.message
            : String(errV2Escaped);
        if (/message is not modified/i.test(msg))
            return;
        logger.debug({ err: errV2Escaped }, 'Escaped MarkdownV2 edit failed, falling back to plain text');
    }
    try {
        await api.editMessageText(chatId, messageId, text, editOptions);
    }
    catch (errPlain) {
        const msg = errPlain instanceof Error ? errPlain.message : String(errPlain);
        if (/message is not modified/i.test(msg))
            return;
        throw errPlain;
    }
}
