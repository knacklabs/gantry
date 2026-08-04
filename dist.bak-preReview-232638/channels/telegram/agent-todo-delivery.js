import { agentTodoStopActions } from '../agent-todo-render.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { telegramThreadOptionsFromString } from './channel-shared.js';
import { renderAgentTodoHtml } from './html-render.js';
import { telegramActionReplyMarkup } from './message-action-affordances.js';
export async function renderTelegramAgentTodo(input) {
    const chatId = input.jid.replace(/^tg:/, '');
    if (!chatId)
        return false;
    const html = renderAgentTodoHtml(input.render);
    const reply_markup = telegramActionReplyMarkup(agentTodoStopActions(input.render));
    const threadId = input.render.threadId ?? undefined;
    const threadOpts = telegramThreadOptionsFromString(threadId);
    const existing = input.pendingTodos.get(input.todoKey);
    if (existing) {
        try {
            await input.api.editMessageText(existing.chatId, existing.messageId, html, {
                parse_mode: 'HTML',
                link_preview_options: { is_disabled: true },
                reply_markup: reply_markup ?? { inline_keyboard: [] },
            });
            return true;
        }
        catch (err) {
            logger.debug({ jid: input.jid, threadId, err: input.sanitizeErrorMessage(err) }, 'Telegram todo edit failed; sending a fresh message');
            input.pendingTodos.delete(input.todoKey);
        }
    }
    try {
        const sent = await input.api.sendMessage(chatId, html, {
            parse_mode: 'HTML',
            link_preview_options: { is_disabled: true },
            ...(reply_markup ? { reply_markup } : {}),
            ...threadOpts,
        });
        input.pendingTodos.set(input.todoKey, {
            chatId,
            messageId: sent.message_id,
        });
        return true;
    }
    catch (err) {
        logger.warn({ jid: input.jid, threadId, err: input.sanitizeErrorMessage(err) }, 'Failed to send Telegram todo message');
    }
    return false;
}
export async function renderTelegramChannelAgentTodo(input) {
    const threadId = input.render.threadId ?? undefined;
    return renderTelegramAgentTodo({
        ...input,
        todoKey: input.buildDraftStreamKey(`${input.jid}:${input.render.cardKind ?? 'todo'}`, threadId),
    });
}
