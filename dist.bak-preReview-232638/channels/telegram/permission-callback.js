import { recoverDurablePermissionDecision, } from '../../application/interactions/pending-interaction-durability.js';
import { formatPermissionReceiptText } from '../permission-interaction.js';
import { escapeTelegramHtml } from './html-render.js';
import { telegramThreadOptionsFromString } from './channel-shared.js';
export async function resolveDurableTelegramPermissionCallback(input) {
    const callbackQuery = input.context.callbackQuery;
    const message = callbackQuery?.message;
    const callbackChatId = message?.chat?.id?.toString() || input.context.chat?.id?.toString() || '';
    const messageId = message?.message_id;
    const userId = callbackQuery?.from?.id?.toString() ||
        input.context.from?.id?.toString() ||
        '';
    if (!callbackChatId || messageId === undefined || !userId) {
        await inactive(input.context);
        return;
    }
    await recoverDurablePermissionDecision({
        locator: {
            kind: 'message',
            appId: input.appId,
            provider: 'telegram',
            conversationId: callbackChatId,
            externalMessageId: String(messageId),
            ...(message?.message_thread_id === undefined
                ? {}
                : { threadId: String(message.message_thread_id) }),
            providerAlias: input.providerAlias,
        },
        surfaceJid: `tg:${callbackChatId}`,
        incomingMode: input.mode,
        incomingApprover: userId,
        authorize: (durable) => durable.approvalContextJid
            ? input.isAuthorized(durable.approvalContextJid, userId, durable)
            : Promise.resolve(false),
        terminalize: (receipt) => terminalizeTelegramPermissionPrompt({
            context: input.context,
            chatId: callbackChatId,
            messageId,
            threadId: receipt.status === 'resolved'
                ? (receipt.context.threadId ?? undefined)
                : message?.message_thread_id?.toString(),
            receipt,
            sanitizeErrorMessage: input.sanitizeErrorMessage,
        }),
        feedback: async (text) => {
            await input.context.answerCallbackQuery({
                text,
                show_alert: text !== 'Decision recorded.',
            });
        },
    });
}
async function terminalizeTelegramPermissionPrompt(input) {
    const approved = input.receipt.status === 'resolved' &&
        input.receipt.decision.approved &&
        input.receipt.decision.mode !== 'cancel';
    if (approved) {
        try {
            await input.context.api.deleteMessage(input.chatId, input.messageId);
            return true;
        }
        catch {
            // Fall through to the visible receipt replacement.
        }
    }
    const text = escapeTelegramHtml(input.receipt.status === 'expired' || !input.receipt.request
        ? (input.receipt.text ?? 'Permission resolved.')
        : formatPermissionReceiptText(input.receipt.request.requestId, input.receipt.request, input.receipt.decision));
    try {
        await input.context.api.editMessageText(input.chatId, input.messageId, text, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [] },
        });
        return true;
    }
    catch {
        try {
            await input.context.api.sendMessage(input.chatId, text, {
                parse_mode: 'HTML',
                ...telegramThreadOptionsFromString(input.threadId),
            });
            return true;
        }
        catch (err) {
            input.sanitizeErrorMessage(err);
            return false;
        }
    }
}
async function inactive(context) {
    await context.answerCallbackQuery({
        text: 'Permission request is no longer active.',
        show_alert: true,
    });
}
