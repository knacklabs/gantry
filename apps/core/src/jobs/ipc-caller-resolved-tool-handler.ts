import { randomUUID } from 'node:crypto';

import { requestCallerResolvedTool } from '../application/interactions/caller-resolved-tool-coordinator.js';
import { isAsyncTaskTerminal } from '../domain/ports/async-tasks.js';
import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import { delegatedTaskAgentInScope } from './async-command-task-helpers.js';
import { taskScope } from './ipc-agent-task-lifecycle-handlers.js';
import { createTaskResponder, toTrimmedString } from './ipc-shared.js';
import type { TaskHandler } from './ipc-types.js';
import { readAsyncCommandSandboxPolicy } from '../runtime/async-command-sandbox-policy.js';

const budgets = new Map<
  string,
  { total: number; scopes: Map<string, number> }
>();

export function resolveCallerResolvedRunId(input: {
  runId?: string;
  parentTaskId?: string;
  sandboxRunId?: string;
  parentTaskRunId?: string | null;
}): string | undefined {
  const direct = input.runId?.trim();
  if (direct) return direct;
  if (!input.parentTaskId?.trim()) return undefined;
  return (
    input.sandboxRunId?.trim() || input.parentTaskRunId?.trim() || undefined
  );
}

export const callerResolvedToolTaskHandler: TaskHandler = async (context) => {
  const responder = createTaskResponder(
    context.sourceAgentFolder,
    context.data.taskId,
    context.data.authThreadId,
    context.data.responseKeyId,
  );
  const parentTaskId = toTrimmedString(context.data.parentTaskId, {
    maxLen: 160,
  });
  const parentTask = parentTaskId
    ? await context.deps.getAsyncTaskRepository?.()?.getTask(parentTaskId)
    : null;
  const inheritedRunId = parentTaskId
    ? readAsyncCommandSandboxPolicy({
        sourceAgentFolder: context.sourceAgentFolder,
        runHandle: context.data.runHandle,
      })?.runId
    : undefined;
  const runId = resolveCallerResolvedRunId({
    runId: context.data.runId,
    parentTaskId,
    sandboxRunId: inheritedRunId,
    parentTaskRunId: parentTask?.parentRunId,
  });
  const scopedContext =
    runId && !context.data.runId
      ? { ...context, data: { ...context.data, runId } }
      : context;
  const scope = taskScope(scopedContext);
  if (!scope || !runId) {
    responder.reject(
      'Caller-resolved tools require an active run.',
      'forbidden',
    );
    return;
  }
  if (
    parentTaskId &&
    (!parentTask ||
      parentTask.kind !== 'delegated_agent' ||
      parentTask.appId !== scope.appId ||
      !delegatedTaskAgentInScope(parentTask, scope.agentId) ||
      parentTask.conversationId !== scope.conversationId ||
      (parentTask.privateCorrelationJson.providerAccountId ?? null) !==
        (scope.providerAccountId ?? null) ||
      (parentTask.threadId ?? null) !== (scope.threadId ?? null) ||
      isAsyncTaskTerminal(parentTask.status))
  ) {
    responder.reject(
      'Parent delegated task is not active in this scope.',
      'forbidden',
    );
    return;
  }
  const job = context.data.jobId
    ? await context.deps.opsRepository.getJobById(context.data.jobId)
    : null;
  const config = context.data.jobId
    ? job?.agent_task?.callerResolvedTools
    : scope.sandboxPolicy.callerResolvedTools;
  const sessionId = context.data.jobId
    ? job?.session_id
    : scope.sandboxPolicy.callerResolvedTools?.sessionId;
  const toolName = toTrimmedString(context.data.payload?.toolName, {
    maxLen: 80,
  });
  const definition = config?.tools.find((tool) => tool.name === toolName);
  if (!config || !sessionId || !toolName) {
    responder.reject(
      'Caller-resolved tool is not declared by this run.',
      'forbidden',
    );
    return;
  }

  const taskKey =
    (typeof parentTask?.privateCorrelationJson.taskKey === 'string'
      ? parentTask.privateCorrelationJson.taskKey
      : null) ?? 'parent';
  const isCompletionGate =
    !parentTaskId && job?.agent_task?.completionGate?.toolName === toolName;
  if (!definition && !isCompletionGate) {
    responder.reject(
      'Caller-resolved tool is not declared by this run.',
      'forbidden',
    );
    return;
  }
  const budgetKey = `${scope.appId}:${runId}`;
  const used = budgets.get(budgetKey) ?? {
    total: 0,
    scopes: new Map<string, number>(),
  };
  const scopeUsed = used.scopes.get(taskKey) ?? 0;
  const scopeLimit = config.maxInteractions;
  const totalLimit = config.maxInteractions;
  if (
    !isCompletionGate &&
    (used.total >= totalLimit || scopeUsed >= scopeLimit)
  ) {
    responder.reject(
      'Caller-resolved tool budget exhausted.',
      'tool_budget_exhausted',
    );
    return;
  }
  if (!isCompletionGate) {
    used.total += 1;
    used.scopes.set(taskKey, scopeUsed + 1);
    budgets.set(budgetKey, used);
  }

  const interactionId = `interaction_${randomUUID()}`;
  try {
    const result = await requestCallerResolvedTool({
      appId: scope.appId,
      runId,
      sourceAgentFolder: context.sourceAgentFolder,
      sessionId,
      interactionId,
      toolName,
      toolInput: context.data.payload?.toolInput ?? {},
      timeoutMs: config.interactionTimeoutMs,
      signal: new AbortController().signal,
      emitRequired: async () => {
        await context.deps.publishRuntimeEvent?.({
          appId: scope.appId as never,
          agentId: scope.agentId as never,
          sessionId: sessionId as never,
          runId: runId as never,
          ...(context.data.jobId ? { jobId: context.data.jobId as never } : {}),
          conversationId: scope.conversationId as never,
          ...(scope.threadId ? { threadId: scope.threadId as never } : {}),
          eventType: RUNTIME_EVENT_TYPES.INTERACTION_PENDING,
          actor: 'gantry-runtime',
          payload: {
            interactionType: 'caller_resolved_tool',
            interactionId,
            toolName,
            input: context.data.payload?.toolInput ?? {},
            taskKey,
            expiresInMs: config.interactionTimeoutMs,
          },
        });
      },
    });
    responder.acceptData('Caller-resolved tool completed.', result);
  } catch (error) {
    responder.reject(
      error instanceof Error ? error.message : String(error),
      'caller_tool_failed',
    );
  }
};
