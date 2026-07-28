import { randomUUID } from 'node:crypto';
import type { CoreTaskOwner } from '../application/core-tools/task-lifecycle.js';
import { requestCallerResolvedTool } from '../application/interactions/caller-resolved-tool-coordinator.js';
import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import type { AsyncCommandSandboxPolicy } from '../runtime/async-command-sandbox-policy.js';
import { createTaskResponder, toTrimmedString } from './ipc-shared.js';
import type { TaskContext, TaskHandler } from './ipc-types.js';

type CallerToolScope = CoreTaskOwner & {
  sandboxPolicy: AsyncCommandSandboxPolicy;
};

const callerToolBudgets = new Map<
  string,
  { total: number; scopes: Map<string, number> }
>();

function callerMcpActivity(payload: unknown): Record<string, unknown>[] {
  if (!Array.isArray(payload)) return [];
  return payload
    .slice(0, 128)
    .filter((value): value is Record<string, unknown> => {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
      const record = value as Record<string, unknown>;
      return (
        typeof record.toolCallId === 'string' &&
        typeof record.serverName === 'string' &&
        typeof record.toolName === 'string' &&
        typeof record.requestedToolRule === 'string' &&
        (record.resultClass === 'attempt' ||
          record.resultClass === 'success' ||
          record.resultClass === 'failure')
      );
    });
}

export function createCallerResolvedToolHandler(input: {
  responder: (context: TaskContext) => ReturnType<typeof createTaskResponder>;
  taskScope: (context: TaskContext) => CallerToolScope | null;
}): TaskHandler {
  return async (context) => {
    const { acceptData, reject } = input.responder(context);
    const scope = input.taskScope(context);
    if (!scope || !context.data.runId) {
      reject('Caller-resolved tools require an active run.', 'forbidden');
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
    const parentTaskId = toTrimmedString(context.data.parentTaskId, {
      maxLen: 160,
    });
    const parentTask = parentTaskId
      ? await context.deps.getAsyncTaskRepository?.()?.getTask(parentTaskId)
      : null;
    const taskKey =
      (typeof parentTask?.privateCorrelationJson.taskKey === 'string'
        ? parentTask.privateCorrelationJson.taskKey
        : null) ?? 'parent';
    const completionGate = job?.agent_task?.delegatedCompletionGate;
    const isCompletionGate = Boolean(
      parentTaskId &&
      completionGate &&
      completionGate.toolName === toolName &&
      completionGate.taskKeys.includes(taskKey),
    );
    if (
      !config ||
      !sessionId ||
      !toolName ||
      (!definition && !isCompletionGate)
    ) {
      reject('Caller-resolved tool is not declared by this run.', 'forbidden');
      return;
    }
    const budget = job?.agent_task?.interactionBudget;
    const budgetKey = `${scope.appId}:${context.data.runId}`;
    const used = callerToolBudgets.get(budgetKey) ?? {
      total: 0,
      scopes: new Map<string, number>(),
    };
    const scopeUsed = used.scopes.get(taskKey) ?? 0;
    const scopeLimit =
      budget?.scopes[taskKey] ?? budget?.maxTotal ?? config.maxInteractions;
    const totalLimit = budget?.maxTotal ?? config.maxInteractions;
    if (!isCompletionGate) {
      if (used.total >= totalLimit || scopeUsed >= scopeLimit) {
        reject(
          'Caller-resolved tool budget exhausted.',
          'tool_budget_exhausted',
        );
        return;
      }
      used.total += 1;
      used.scopes.set(taskKey, scopeUsed + 1);
      callerToolBudgets.set(budgetKey, used);
    }
    const interactionId = `interaction_${randomUUID()}`;
    try {
      for (const activity of callerMcpActivity(
        context.data.payload?.mcpActivity,
      )) {
        await context.deps.publishRuntimeEvent?.({
          appId: scope.appId as never,
          agentId: scope.agentId as never,
          sessionId: sessionId as never,
          runId: context.data.runId as never,
          ...(context.data.jobId ? { jobId: context.data.jobId as never } : {}),
          conversationId: scope.conversationId as never,
          ...(scope.threadId ? { threadId: scope.threadId as never } : {}),
          ...(scope.sandboxPolicy.correlationId
            ? { correlationId: scope.sandboxPolicy.correlationId as never }
            : {}),
          eventType: RUNTIME_EVENT_TYPES.MCP_TOOL_ACTIVITY,
          actor: 'mcp-stdio-audit-proxy',
          responseMode: 'none',
          payload: activity,
        });
      }
      const result = await requestCallerResolvedTool({
        appId: scope.appId,
        runId: context.data.runId,
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
            runId: context.data.runId as never,
            ...(context.data.jobId
              ? { jobId: context.data.jobId as never }
              : {}),
            conversationId: scope.conversationId as never,
            ...(scope.threadId ? { threadId: scope.threadId as never } : {}),
            ...(scope.sandboxPolicy.correlationId
              ? { correlationId: scope.sandboxPolicy.correlationId as never }
              : {}),
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
      acceptData('Caller-resolved tool completed.', result);
    } catch (error) {
      reject(
        error instanceof Error ? error.message : String(error),
        'caller_tool_failed',
      );
    }
  };
}
