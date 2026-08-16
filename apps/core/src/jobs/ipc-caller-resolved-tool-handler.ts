import { randomUUID } from 'node:crypto';

import { requestCallerResolvedTool } from '../application/interactions/caller-resolved-tool-coordinator.js';
import { isAsyncTaskTerminal } from '../domain/ports/async-tasks.js';
import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import { delegatedTaskAgentInScope } from './async-command-task-helpers.js';
import { taskScope } from './ipc-agent-task-lifecycle-handlers.js';
import { createTaskResponder, toTrimmedString } from './ipc-shared.js';
import type { TaskHandler } from './ipc-types.js';
import { memoryAgentIdForWorkspaceFolder } from '../memory/app-memory-boundaries.js';
import {
  grantAsyncCommandBrowserHost,
  readAsyncCommandSandboxPolicy,
} from '../runtime/async-command-sandbox-policy.js';
import { parseDeclaredNetworkHost } from '../shared/network-host-declaration.js';

const WEBSITE_RECIPE_HUMAN_TOOL = 'website_recipe_request_human';

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
  const activeSandboxPolicy = context.data.runHandle
    ? readAsyncCommandSandboxPolicy({
        sourceAgentFolder: context.sourceAgentFolder,
        runHandle: context.data.runHandle,
      })
    : undefined;
  const usesInteractionBudget = callerResolvedToolUsesInteractionBudget(
    toolName,
    activeSandboxPolicy?.browserPolicy,
  );
  if (!definition && !isCompletionGate) {
    responder.reject(
      'Caller-resolved tool is not declared by this run.',
      'forbidden',
    );
    return;
  }
  if (toolName === WEBSITE_RECIPE_HUMAN_TOOL && context.data.jobId) {
    const checkpointRepository =
      context.deps.getJobSemanticCheckpointRepository?.();
    if (!checkpointRepository) {
      responder.reject(
        'Durable job checkpoints are unavailable.',
        'unavailable',
      );
      return;
    }
    const checkpoint = await checkpointRepository.getLatestCheckpoint({
      appId: scope.appId,
      agentId: memoryAgentIdForWorkspaceFolder(context.sourceAgentFolder),
      jobId: context.data.jobId,
    });
    if (!recipeHumanWaitCheckpointReady(checkpoint?.milestone)) {
      responder.reject(
        'Save a human-wait semantic checkpoint before requesting recipe assistance.',
        'checkpoint_required',
      );
      return;
    }
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
    usesInteractionBudget &&
    (used.total >= totalLimit || scopeUsed >= scopeLimit)
  ) {
    responder.reject(
      'Caller-resolved tool budget exhausted.',
      'tool_budget_exhausted',
    );
    return;
  }
  if (!isCompletionGate && usesInteractionBudget) {
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
    if (
      toolName === WEBSITE_RECIPE_HUMAN_TOOL &&
      context.data.jobId &&
      context.data.runHandle
    ) {
      const host = approvedRecipeOriginHost({
        request: context.data.payload?.toolInput,
        resolution: result,
      });
      if (host) {
        const activePolicy = readAsyncCommandSandboxPolicy({
          sourceAgentFolder: context.sourceAgentFolder,
          runHandle: context.data.runHandle,
        });
        if (
          activePolicy?.browserPolicy !== 'recipe_authoring' ||
          activePolicy.jobId !== context.data.jobId ||
          activePolicy.runId !== runId
        ) {
          throw new Error(
            'Recipe origin grant no longer matches the active run.',
          );
        }
        const currentJob = await context.deps.opsRepository.getJobById(
          context.data.jobId,
        );
        if (!currentJob?.agent_task) {
          throw new Error('Recipe origin grant job is no longer available.');
        }
        const browserAllowedNetworkHosts = [
          ...new Set([
            ...(currentJob.agent_task.browserAllowedNetworkHosts ?? []),
            host,
          ]),
        ];
        await context.deps.opsRepository.updateJob(currentJob.id, {
          agent_task: {
            ...currentJob.agent_task,
            browserAllowedNetworkHosts,
          },
        });
        if (
          !grantAsyncCommandBrowserHost({
            sourceAgentFolder: context.sourceAgentFolder,
            runHandle: context.data.runHandle,
            jobId: currentJob.id,
            runId,
            host,
          })
        ) {
          throw new Error(
            'Recipe origin grant no longer matches the active run.',
          );
        }
      }
    }
    responder.acceptData('Caller-resolved tool completed.', result);
  } catch (error) {
    responder.reject(
      error instanceof Error ? error.message : String(error),
      'caller_tool_failed',
    );
  }
};

export function callerResolvedToolUsesInteractionBudget(
  toolName: string | undefined,
  browserPolicy: string | undefined,
): boolean {
  return !(
    toolName === WEBSITE_RECIPE_HUMAN_TOOL &&
    browserPolicy === 'recipe_authoring'
  );
}

export function recipeHumanWaitCheckpointReady(
  milestone: string | undefined,
): boolean {
  return milestone === 'human_wait';
}

export function approvedRecipeOriginHost(input: {
  request: unknown;
  resolution: unknown;
}): string | null {
  const request = record(input.request);
  const resolution = record(input.resolution);
  if (request.type !== 'origin' || resolution.approved !== true) return null;
  const requestedScope = record(request.permissionScope);
  const resolvedScope = record(resolution.permissionScope);
  const origin =
    typeof requestedScope.origin === 'string'
      ? requestedScope.origin.trim()
      : '';
  if (!origin || resolvedScope.origin !== origin) {
    throw new Error(
      'Recipe origin approval must match the requested exact origin.',
    );
  }
  const requestedMethods = strings(requestedScope.methods);
  const resolvedMethods = strings(resolvedScope.methods);
  if (
    resolvedMethods.length === 0 ||
    resolvedMethods.some(
      (method) =>
        !requestedMethods.includes(method) || !['GET', 'HEAD'].includes(method),
    )
  ) {
    throw new Error(
      'Recipe origin approval permits only requested GET or HEAD methods.',
    );
  }
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error('Recipe origin approval contains an invalid origin.');
  }
  if (
    url.protocol !== 'https:' ||
    url.origin !== origin ||
    url.username ||
    url.password
  ) {
    throw new Error('Recipe origin approval requires an exact HTTPS origin.');
  }
  const parsed = parseDeclaredNetworkHost(
    `${url.hostname}${url.port ? `:${url.port}` : ''}`,
  );
  if (!parsed.ok) throw new Error(`Recipe origin approval ${parsed.reason}`);
  return parsed.host;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}
