import type { AgentTodoItem } from '../domain/ports/task-lifecycle.js';
import { nowIso } from '../shared/time/datetime.js';
import { logger } from '../infrastructure/logging/logger.js';
import { createTaskResponder, toTrimmedString } from './ipc-shared.js';
import type { TaskContext, TaskHandler } from './ipc-types.js';

const TODO_STATUSES = new Set([
  'pending',
  'inProgress',
  'completed',
  'blocked',
]);
const MAX_TODO_ITEMS = 50;

function responder(context: TaskContext) {
  return createTaskResponder(
    context.sourceAgentFolder,
    context.data.taskId,
    context.data.authThreadId,
    context.data.responseKeyId,
  );
}

function normalizeTodoItems(value: unknown): AgentTodoItem[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > MAX_TODO_ITEMS
  ) {
    return null;
  }
  const items: AgentTodoItem[] = [];
  const ids = new Set<string>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      return null;
    const record = entry as Record<string, unknown>;
    const id = toTrimmedString(record.id, { maxLen: 80 });
    const title = toTrimmedString(record.title, { maxLen: 240 });
    const status = toTrimmedString(record.status, { maxLen: 32 });
    if (!id || !title || !status || !TODO_STATUSES.has(status) || ids.has(id)) {
      return null;
    }
    ids.add(id);
    const note = toTrimmedString(record.note, { maxLen: 500 });
    items.push({
      id,
      title,
      status: status as AgentTodoItem['status'],
      ...(note ? { note } : {}),
    });
  }
  return items;
}

function validateSameConversation(context: TaskContext): string | null {
  const conversationId = toTrimmedString(context.data.chatJid, {
    maxLen: 255,
  });
  if (
    !conversationId ||
    !context.sourceAgentFolderJids.includes(conversationId)
  ) {
    return null;
  }
  return conversationId;
}

const todoUpdateHandler: TaskHandler = async (context) => {
  const { accept, reject } = responder(context);
  const conversationId = validateSameConversation(context);
  if (!conversationId) {
    reject(
      'todo_update must target the originating conversation.',
      'forbidden',
    );
    return;
  }
  const payload = context.data.payload ?? {};
  const items = normalizeTodoItems(payload.items);
  if (!items) {
    reject(
      'todo_update requires 1-50 unique items with id, title, and status.',
      'invalid_request',
    );
    return;
  }
  const summary = toTrimmedString(payload.summary, { maxLen: 500 }) || null;
  const updatedAt = nowIso();
  const threadId = context.data.authThreadId || context.data.threadId || null;
  if (context.deps.renderAgentTodo) {
    await context.deps
      .renderAgentTodo(conversationId, {
        summary,
        items,
        threadId,
        updatedAt,
      })
      .catch((err) => {
        logger.debug(
          { err, conversationId },
          'todo_update channel render failed',
        );
      });
  }
  accept('Plan updated.');
};

export const agentTaskLifecycleHandlers: Record<string, TaskHandler> = {
  todo_update: todoUpdateHandler,
};
