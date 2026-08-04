import type { Api, Context } from 'grammy';
import type { StreamFlavor } from '@grammyjs/stream';
import { streamApi } from '@grammyjs/stream';
import type { ChannelOpts } from '../channel-provider.js';
import type { UserQuestionRequest } from '../../domain/types.js';
export { splitTelegramTextByCodeUnits } from './channel-delivery-text-splitting.js';
export { escapeTelegramMarkdownV2, escapeTelegramMarkdownV2CodeSegment, escapeTelegramMarkdownV2LinkSegment, escapeTelegramMarkdownV2Literal, escapeTelegramMarkdownV2Plain, } from './telegram-markdown-v2-escape.js';
export type TelegramChannelOpts = ChannelOpts;
export declare const TELEGRAM_MEDIA_DOWNLOAD_CONCURRENCY = 2;
export declare const TELEGRAM_MEDIA_DOWNLOAD_QUEUE_MAX = 512;
export declare const TELEGRAM_MEDIA_DRAIN_TIMEOUT_MS = 5000;
export declare const TELEGRAM_MESSAGE_MAX_LENGTH = 4096;
export declare const TELEGRAM_STREAM_CHUNK_MAX_LENGTH = 3500;
export declare const TELEGRAM_GROUP_EDIT_INTERVAL_MS: 950;
export declare const TELEGRAM_INLINE_BUTTON_TEXT_MAX_BYTES = 56;
export declare const TELEGRAM_USER_QUESTION_TIMEOUT_MS: number;
export declare const TELEGRAM_PERMISSION_CALLBACK_PATTERN: RegExp;
export declare const TELEGRAM_USER_QUESTION_CALLBACK_PATTERN: RegExp;
export declare const TELEGRAM_DEAD_LETTER_ACTION_CALLBACK_PATTERN: RegExp;
export declare function sanitizeTelegramErrorMessage(err: unknown, botToken: string): string;
export type TelegramContext = StreamFlavor<Context>;
export type TelegramStreamApi = ReturnType<typeof streamApi>;
export type ActiveDraftStreamState = {
    chatId: number;
    threadId?: number;
    generation?: number;
    rawBuffer: string;
    pushChunk: (chunk: string) => void;
    closeStream: () => void;
    streamPromise: Promise<void>;
};
export type ActiveGroupStreamState = {
    chatId: string;
    threadId?: number;
    generation?: number;
    rawBuffer: string;
    messageId?: number;
    lastFlushAt: number;
};
export type ActiveProgressState = {
    chatId: string;
    threadId?: number;
    messageId?: number;
    lastText: string;
    generation?: number;
    restored?: boolean;
};
export type PendingUserQuestionState = {
    callbackId: string;
    appId: string;
    requestId: string;
    sourceAgentFolder: string;
    questionIndex: number;
    questionHeader: string;
    questionText: string;
    promptText: string;
    /** Whether promptText is HTML (sent with parse_mode:'HTML') or plain text. */
    promptIsHtml: boolean;
    optionLabels: string[];
    multiSelect: boolean;
    selectedOptionIndexes: Set<number>;
    chatId: string;
    messageId: number;
    timer?: ReturnType<typeof setTimeout>;
    resolve: (selection: {
        selected: string | string[];
        answeredBy?: string;
    }) => void;
};
export type TelegramUserQuestionCallbackTarget = Pick<PendingUserQuestionState, 'appId' | 'sourceAgentFolder' | 'requestId' | 'questionIndex'>;
export declare function telegramQuestionCallbackId(): string;
export declare function createPendingTelegramUserQuestion(input: {
    callbackId: string;
    pendingKey: string;
    request: UserQuestionRequest;
    question: UserQuestionRequest['questions'][number];
    questionIndex: number;
    chatId: string;
    messageId: number;
    promptText: string;
    promptIsHtml: boolean;
    timeoutMs: number;
    pendingQuestions: Map<string, PendingUserQuestionState>;
    callbacks: Map<string, TelegramUserQuestionCallbackTarget>;
    finalize: (pending: PendingUserQuestionState, selection: string | string[], answeredBy: string, outcome: string) => Promise<void>;
}): Promise<{
    selected: string | string[];
    answeredBy?: string;
}>;
export declare function splitTelegramDeliveryText(text: string, softCodeUnitBudget?: number, hardCodeUnitLimit?: number): string[];
export declare function truncateText(text: string, maxLen: number): string;
export declare function telegramThreadOptionsFromString(threadId?: string): {
    message_thread_id?: number;
};
export declare function truncateUtf8ToByteLimit(text: string, maxBytes: number): string;
export declare function stripInternalTagsPreserveWhitespace(text: string): string;
export declare function formatTelegramStreamingText(rawText: string, done?: boolean): string;
export type TelegramSendMessageOptions = NonNullable<Parameters<Api['sendMessage']>[2]>;
/**
 * Send a message with Telegram MarkdownV2, then plain text.
 */
export declare function sendTelegramMessage(api: {
    sendMessage: Api['sendMessage'];
}, chatId: string | number, text: string, options?: TelegramSendMessageOptions): Promise<void>;
type TelegramMarkdownEscapeOptions = {
    preserveStyleMarkers?: boolean;
};
export declare function sendTelegramMessageWithResult(api: {
    sendMessage: Api['sendMessage'];
}, chatId: string | number, text: string, options?: TelegramSendMessageOptions, escapeOptions?: TelegramMarkdownEscapeOptions): Promise<number | undefined>;
export declare function editTelegramMessage(api: {
    editMessageText: Api['editMessageText'];
}, chatId: string | number, messageId: number, text: string, escapeOptions?: TelegramMarkdownEscapeOptions, editOptions?: Record<string, unknown>): Promise<void>;
