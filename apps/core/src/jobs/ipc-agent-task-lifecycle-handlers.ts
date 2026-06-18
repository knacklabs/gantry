import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';

import type {
  AgentTodoItem,
  DelegatedTask,
  DelegatedTaskScope,
} from '../domain/ports/task-lifecycle.js';
import { resolveConfiguredAllowedTools } from '../runtime/configured-agent-tools.js';
import { memoryAgentIdForWorkspaceFolder } from '../memory/app-memory-boundaries.js';
import { readLiveToolRules } from '../shared/live-tool-rules.js';
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
const AGENT_DELEGATION_RULE = 'AgentDelegation';

function responder(context: TaskContext) {
  return createTaskResponder(
    context.sourceAgentFolder,
    context.data.taskId,
    context.data.authThreadId,
    context.data.responseKeyId,
  );
}

function stringHash(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(value))
    .digest('hex')
    .slice(0, 32);
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
    const taskId = toTrimmedString(record.taskId, { maxLen: 128 });
    const note = toTrimmedString(record.note, { maxLen: 500 });
    items.push({
      id,
      title,
      status: status as AgentTodoItem['status'],
      ...(taskId ? { taskId } : {}),
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

function buildScope(
  context: TaskContext,
  conversationId: string,
): DelegatedTaskScope {
  const appId = context.data.appId || 'default';
  const agentId =
    context.data.agentId ||
    memoryAgentIdForWorkspaceFolder(context.sourceAgentFolder);
  return {
    appId,
    agentId,
    principalId: conversationId,
    conversationId,
    threadId: context.data.authThreadId || context.data.threadId || null,
    parentRunId: context.data.runId || null,
    runHandle: context.data.runHandle || null,
  };
}

function fenceFromContext(context: TaskContext) {
  return {
    leaseToken: context.data.runLeaseToken || null,
    fencingVersion:
      typeof context.data.runLeaseFencingVersion === 'number'
        ? context.data.runLeaseFencingVersion
        : null,
  };
}

async function hasAgentDelegation(context: TaskContext): Promise<boolean> {
  if (!context.data.appId) return false;
  const agentId =
    context.data.agentId ||
    memoryAgentIdForWorkspaceFolder(context.sourceAgentFolder);
  const rules = new Set<string>();
  const configured = await resolveConfiguredAllowedTools({
    repository: context.deps.getToolRepository?.(),
    skillRepository: context.deps.getSkillRepository?.(),
    appId: context.data.appId,
    agentId,
  });
  for (const rule of configured ?? []) rules.add(rule);
  const liveIpcDir =
    context.ipcBaseDir && context.sourceAgentFolder
      ? path.join(context.ipcBaseDir, context.sourceAgentFolder)
      : undefined;
  for (const rule of readLiveToolRules({
    ipcDir: liveIpcDir,
    runHandle: context.data.runHandle,
  })) {
    rules.add(rule);
  }
  return rules.has(AGENT_DELEGATION_RULE);
}

function taskPublicData(task: DelegatedTask): Record<string, unknown> {
  return {
    taskId: task.id,
    status: task.status,
    title: task.title,
    summary: task.resultSummary ?? task.errorSummary ?? null,
    updatedAt: task.updatedAt,
    ...(task.terminalReceipt
      ? {
          receipt: {
            Completed: task.terminalReceipt.completed,
            Used: task.terminalReceipt.used,
            Changed: task.terminalReceipt.changed,
            Delegated: task.terminalReceipt.delegated,
            'Needs attention': task.terminalReceipt.needsAttention,
          },
        }
      : {}),
  };
}

function receiptMessage(task: DelegatedTask): string {
  if (!task.terminalReceipt) return `Delegated task ${task.status}.`;
  return [
    `Completed: ${task.terminalReceipt.completed}`,
    `Used: ${task.terminalReceipt.used}`,
    `Changed: ${task.terminalReceipt.changed}`,
    `Delegated: ${task.terminalReceipt.delegated}`,
    `Needs attention: ${task.terminalReceipt.needsAttention}`,
  ].join('\n');
}

const todoUpdateHandler: TaskHandler = async (context) => {
  const { acceptData, reject } = responder(context);
  const conversationId = validateSameConversation(context);
  if (!conversationId) {
    reject(
      'todo_update must target the originating conversation.',
      'forbidden',
    );
    return;
  }
  const repo = context.deps.getTaskLifecycleRepository?.();
  if (!repo) {
    reject('Task lifecycle storage is not ready.', 'preflight_failed');
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
  const scope = buildScope(context, conversationId);
  const update = await repo.recordTodoUpdate({
    id: `todo-${randomUUID()}`,
    scope,
    summary,
    items,
    idempotencyKey: `todo:${stringHash({
      scope,
      summary,
      items,
      requestTaskId: context.data.taskId,
    })}`,
    fence: fenceFromContext(context),
    fencingVersion: context.data.runLeaseFencingVersion ?? null,
    now: nowIso(),
  });
  if (update.outcome === 'stale_fence') {
    reject(
      'Plan update rejected because the run lease is no longer active.',
      'stale_fence',
    );
    return;
  }
  // Best-effort live render to the originating channel; never fail the tool
  // response on a render error (the durable update already succeeded).
  if (context.deps.renderAgentTodo) {
    await context.deps
      .renderAgentTodo(conversationId, {
        summary,
        items,
        updatedAt: update.update.createdAt,
      })
      .catch((err) => {
        logger.debug(
          { err, conversationId },
          'todo_update channel render failed',
        );
      });
  }
  acceptData('Plan updated.', {
    outcome: update.outcome,
    todoUpdateId: update.update.id,
    updatedAt: update.update.createdAt,
  });
};

const delegateTaskHandler: TaskHandler = async (context) => {
  const { reject } = responder(context);
  const conversationId = validateSameConversation(context);
  if (!conversationId) {
    reject(
      'delegate_task must target the originating conversation.',
      'forbidden',
    );
    return;
  }
  if (!(await hasAgentDelegation(context))) {
    reject(
      'Agent delegation is not approved for this agent.',
      'missing_capability',
    );
    return;
  }
  // No host worker currently claims delegated task rows; fail closed instead
  // of persisting a running task that cannot complete.
  reject(
    'Agent delegation is unavailable in this mode because no Gantry delegation executor is configured.',
    'unavailable_in_mode',
  );
};

const taskGetHandler: TaskHandler = async (context) => {
  const { acceptData, reject } = responder(context);
  const conversationId = validateSameConversation(context);
  if (!conversationId) {
    reject('task_get must target the originating conversation.', 'forbidden');
    return;
  }
  if (!(await hasAgentDelegation(context))) {
    reject(
      'Agent delegation is not approved for this agent.',
      'missing_capability',
    );
    return;
  }
  const repo = context.deps.getTaskLifecycleRepository?.();
  if (!repo) {
    reject('Task lifecycle storage is not ready.', 'preflight_failed');
    return;
  }
  const taskId = toTrimmedString(context.data.payload?.taskId, {
    maxLen: 160,
  });
  if (!taskId) {
    reject('task_get requires taskId.', 'invalid_request');
    return;
  }
  const result = await repo.getDelegatedTask({
    taskId,
    scope: buildScope(context, conversationId),
    fence: fenceFromContext(context),
    now: nowIso(),
  });
  if (result.outcome !== 'found') {
    reject(`Delegated task ${result.outcome}.`, result.outcome);
    return;
  }
  acceptData(receiptMessage(result.task), taskPublicData(result.task));
};

const taskCancelHandler: TaskHandler = async (context) => {
  const { acceptData, reject } = responder(context);
  const conversationId = validateSameConversation(context);
  if (!conversationId) {
    reject(
      'task_cancel must target the originating conversation.',
      'forbidden',
    );
    return;
  }
  if (!(await hasAgentDelegation(context))) {
    reject(
      'Agent delegation is not approved for this agent.',
      'missing_capability',
    );
    return;
  }
  const repo = context.deps.getTaskLifecycleRepository?.();
  if (!repo) {
    reject('Task lifecycle storage is not ready.', 'preflight_failed');
    return;
  }
  const taskId = toTrimmedString(context.data.payload?.taskId, {
    maxLen: 160,
  });
  if (!taskId) {
    reject('task_cancel requires taskId.', 'invalid_request');
    return;
  }
  const result = await repo.cancelDelegatedTask({
    taskId,
    scope: buildScope(context, conversationId),
    fence: fenceFromContext(context),
    reason: toTrimmedString(context.data.payload?.reason, { maxLen: 500 }),
    now: nowIso(),
  });
  if (result.outcome !== 'cancelled' && result.outcome !== 'already_terminal') {
    reject(`Delegated task ${result.outcome}.`, result.outcome);
    return;
  }
  if (result.outcome === 'already_terminal') {
    reject(
      'Delegated task is already finished and cannot be cancelled.',
      'already_terminal',
    );
    return;
  }
  logger.info(
    { taskId, sourceAgentFolder: context.sourceAgentFolder },
    'Delegated task cancelled at Gantry lifecycle boundary',
  );
  acceptData(
    'Delegated work was cancelled. Nothing else changed.',
    taskPublicData(result.task),
  );
};

export const agentTaskLifecycleHandlers: Record<string, TaskHandler> = {
  todo_update: todoUpdateHandler,
  delegate_task: delegateTaskHandler,
  task_get: taskGetHandler,
  task_cancel: taskCancelHandler,
};
