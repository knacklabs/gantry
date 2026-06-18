import type { AgentTodoRender } from '../../domain/ports/task-lifecycle.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { telegramThreadOptionsFromString } from './channel-shared.js';
import { renderAgentTodoHtml } from './html-render.js';

export async function renderTelegramAgentTodo(input: {
  api: {
    editMessageText: (...args: any[]) => Promise<unknown>;
    sendMessage: (...args: any[]) => Promise<{ message_id: number }>;
  };
  jid: string;
  render: AgentTodoRender;
  todoKey: string;
  pendingTodos: Map<string, { chatId: string; messageId: number }>;
  sanitizeErrorMessage: (err: unknown) => unknown;
}): Promise<void> {
  const chatId = input.jid.replace(/^tg:/, '');
  if (!chatId) return;
  const html = renderAgentTodoHtml(input.render);
  const threadId = input.render.threadId ?? undefined;
  const threadOpts = telegramThreadOptionsFromString(threadId);
  const existing = input.pendingTodos.get(input.todoKey);
  if (existing) {
    try {
      await input.api.editMessageText(
        existing.chatId,
        existing.messageId,
        html,
        {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        },
      );
      return;
    } catch (err) {
      logger.debug(
        { jid: input.jid, threadId, err: input.sanitizeErrorMessage(err) },
        'Telegram todo edit failed; sending a fresh message',
      );
      input.pendingTodos.delete(input.todoKey);
    }
  }
  try {
    const sent = await input.api.sendMessage(chatId, html, {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...threadOpts,
    });
    input.pendingTodos.set(input.todoKey, {
      chatId,
      messageId: sent.message_id,
    });
  } catch (err) {
    logger.warn(
      { jid: input.jid, threadId, err: input.sanitizeErrorMessage(err) },
      'Failed to send Telegram todo message',
    );
  }
}
