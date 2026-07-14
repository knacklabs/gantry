import type { AgentTodoItem } from '../domain/ports/task-lifecycle.js';
import { randomUUID } from 'node:crypto';
import { AsyncCommandTaskService } from './async-command-task-service.js';
import {
  isAsyncTaskTerminal,
  type AsyncTaskRepository,
  type AsyncTaskRecord,
} from '../domain/ports/async-tasks.js';
import { nowIso } from '../shared/time/datetime.js';
import { logger } from '../infrastructure/logging/logger.js';
import {
  createTaskResponder,
  respondTaskLifecycleResult,
  toTrimmedString,
} from './ipc-shared.js';
import type { TaskContext, TaskHandler } from './ipc-types.js';
import { resolveConfiguredAllowedTools } from '../runtime/configured-agent-tools.js';
import { resolveWorkspaceFolderPath } from '../platform/workspace-folder.js';
import type { AgentOutput } from '../runtime/agent-spawn-types.js';
import { spawnAgent } from '../runtime/agent-spawn.js';
import {
  taskContinuationThreadId,
  writeContinuationInput,
} from '../runtime/continuation-input.js';
import { memoryAgentIdForWorkspaceFolder } from '../memory/app-memory-boundaries.js';
import { readLiveToolRules } from '../shared/live-tool-rules.js';
import {
  readAsyncCommandSandboxPolicy,
  type AsyncCommandSandboxPolicy,
} from '../runtime/async-command-sandbox-policy.js';
import path from 'node:path';
import {
  closeEgressGateway,
  ensureEgressGateway,
} from '../runtime/egress-gateway.js';
import {
  DEFAULT_ASYNC_COMMAND_TIMEOUT_MS,
  DEFAULT_ASYNC_RESOURCE_LIMITS,
  buildAsyncCommandEnv,
  runSandboxedAsyncCommand,
} from './async-command-sandbox-runner.js';
import { resolveTurnToolPolicy } from '../runtime/group-run-context.js';
import { createCoreTaskLifecycleBackend } from '../application/core-tools/task-lifecycle.js';
import { delegatedTaskAgentInScope } from './async-command-task-helpers.js';
import { resolveDelegatedAgentTarget } from './ipc-agent-delegation-target.js';

const TODO_STATUSES = new Set([
  'pending',
  'inProgress',
  'completed',
  'blocked',
]);
const MAX_TODO_ITEMS = 50;
const DEFAULT_DELEGATED_AGENT_TIMEOUT_MS = 30 * 60_000;
const asyncCommandServices = new WeakMap<
  AsyncTaskRepository,
  AsyncCommandTaskService
>();
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
function taskService(context: TaskContext): AsyncCommandTaskService | null {
  const repository = context.deps.getAsyncTaskRepository?.();
  const runnerSandboxProvider = context.deps.runnerSandboxProvider;
  if (!repository || !runnerSandboxProvider?.enforcing) return null;
  const existing = asyncCommandServices.get(repository);
  if (existing) return existing;
  const service = new AsyncCommandTaskService(
    repository,
    {
      run: async (input) =>
        runSandboxedAsyncCommand(runnerSandboxProvider, {
          ...input,
          cwd: input.cwd ?? process.cwd(),
          env: buildAsyncCommandEnv(),
          timeoutMs: DEFAULT_ASYNC_COMMAND_TIMEOUT_MS,
          outputMaxBytes: 4_000,
          protectedReadPaths: [...(input.protectedReadPaths ?? [])],
          protectedWritePaths: [...(input.protectedWritePaths ?? [])],
          allowedNetworkHosts: [...(input.allowedNetworkHosts ?? [])],
          egressProxyUrl: input.egressProxyUrl,
          resourceLimits: input.resourceLimits ?? DEFAULT_ASYNC_RESOURCE_LIMITS,
        }),
    },
    {
      prepareRun: async ({ task, allowedNetworkHosts }) => {
        const gateway = await ensureEgressGateway({
          key: `${task.appId}:${task.agentId}:${task.id}`,
          settings: context.deps.getEgressSettings?.() ?? { denylist: [] },
          principal: {
            appId: task.appId,
            agentId: task.agentId,
            ...(task.conversationId
              ? { conversationId: task.conversationId }
              : {}),
            ...(task.threadId ? { threadId: task.threadId } : {}),
            ...(task.parentRunId ? { runId: task.parentRunId } : {}),
            ...(task.parentJobId ? { jobId: task.parentJobId } : {}),
          },
          ...(allowedNetworkHosts && allowedNetworkHosts.length > 0
            ? { allowedNetworkHosts }
            : {}),
          ...(context.deps.publishRuntimeEvent
            ? { publishRuntimeEvent: context.deps.publishRuntimeEvent }
            : {}),
        });
        return {
          egressProxyUrl: gateway.proxyUrl,
          cleanup: () => closeEgressGateway(gateway),
        };
      },
    },
  );
  asyncCommandServices.set(repository, service);
  return service;
}
function taskBackend(
  context: TaskContext,
  service: AsyncCommandTaskService,
  owner: Parameters<typeof createCoreTaskLifecycleBackend>[0]['owner'],
  parent: { parentTaskId: string | null },
  deliverTaskMessage?: (task: AsyncTaskRecord, message: string) => void,
) {
  return createCoreTaskLifecycleBackend({
    service,
    owner,
    parentTaskId: parent.parentTaskId,
    workspaceFolder: context.sourceAgentFolder,
    deliverTaskMessage,
  });
}
function taskScope(context: TaskContext): {
  appId: string;
  agentId: string;
  conversationId: string;
  providerAccountId?: string | null;
  threadId?: string | null;
  sandboxPolicy: AsyncCommandSandboxPolicy;
} | null {
  const conversationId = validateSameConversation(context);
  if (!conversationId) return null;
  const sandboxPolicy = readAsyncCommandSandboxPolicy({
    sourceAgentFolder: context.sourceAgentFolder,
    runHandle: context.data.runHandle,
  });
  if (!sandboxPolicy) return null;
  const appId = toTrimmedString(context.data.appId, { maxLen: 120 });
  const agentId = toTrimmedString(context.data.agentId, { maxLen: 120 });
  const expectedAgentId = memoryAgentIdForWorkspaceFolder(
    context.sourceAgentFolder,
  );
  if (!appId || !agentId || agentId !== expectedAgentId) return null;
  if (sandboxPolicy.appId !== appId) return null;
  if (sandboxPolicy.agentId && sandboxPolicy.agentId !== agentId) return null;
  if (sandboxPolicy.conversationId !== conversationId) return null;
  if (
    sandboxPolicy.providerAccountId &&
    sandboxPolicy.providerAccountId !== context.data.providerAccountId
  )
    return null;
  if (
    sandboxPolicy.threadId !== undefined &&
    sandboxPolicy.threadId !== null &&
    sandboxPolicy.threadId !==
      (context.data.authThreadId || context.data.threadId)
  ) {
    return null;
  }
  if (sandboxPolicy.runId && sandboxPolicy.runId !== context.data.runId) {
    return null;
  }
  if (sandboxPolicy.jobId && sandboxPolicy.jobId !== context.data.jobId) {
    return null;
  }
  return {
    appId,
    agentId,
    conversationId,
    providerAccountId: sandboxPolicy.providerAccountId ?? null,
    threadId: context.data.authThreadId || context.data.threadId || null,
    sandboxPolicy,
  };
}
async function validateParentTaskScope(
  context: TaskContext,
  scope: {
    appId: string;
    agentId: string;
    conversationId: string;
    providerAccountId?: string | null;
    threadId?: string | null;
  },
): Promise<
  { ok: true; parentTaskId: string | null } | { ok: false; message: string }
> {
  const parentTaskId = toTrimmedString(context.data.parentTaskId, {
    maxLen: 120,
  });
  if (!parentTaskId) return { ok: true, parentTaskId: null };
  const parent = await context.deps
    .getAsyncTaskRepository?.()
    ?.getTask(parentTaskId);
  const valid =
    parent &&
    parent.kind === 'delegated_agent' &&
    parent.appId === scope.appId &&
    delegatedTaskAgentInScope(parent, scope.agentId) &&
    parent.conversationId === scope.conversationId &&
    (parent.privateCorrelationJson.providerAccountId ?? null) ===
      (scope.providerAccountId ?? null) &&
    (parent.threadId ?? null) === (scope.threadId ?? null) &&
    !isAsyncTaskTerminal(parent.status);
  if (!valid) {
    return {
      ok: false,
      message: 'Parent delegated task is not active in this scope.',
    };
  }
  return { ok: true, parentTaskId };
}
async function configuredAllowedTools(
  context: TaskContext,
  scope: { appId: string; agentId: string },
): Promise<string[]> {
  const durableRules =
    (await resolveConfiguredAllowedTools({
      repository: context.deps.getToolRepository?.(),
      skillRepository: context.deps.getSkillRepository?.(),
      appId: scope.appId,
      agentId: scope.agentId,
    })) ?? [];
  const liveRules = readLiveToolRules({
    ipcDir: context.ipcBaseDir
      ? path.join(context.ipcBaseDir, context.sourceAgentFolder)
      : undefined,
    runHandle: context.data.runHandle,
  });
  return [...new Set([...durableRules, ...liveRules])];
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
  if (context.deps.renderAgentTodo && !context.data.jobId) {
    await context.deps
      .renderAgentTodo(
        conversationId,
        {
          summary,
          items,
          threadId,
          updatedAt,
          stop: context.data.liveStopActionToken
            ? { label: 'Stop', actionToken: context.data.liveStopActionToken }
            : undefined,
        },
        context.data.providerAccountId
          ? { providerAccountId: context.data.providerAccountId }
          : undefined,
      )
      .catch((err) => {
        logger.debug(
          { err, conversationId },
          'todo_update channel render failed',
        );
      });
  }
  accept('Plan updated.');
};
const asyncRunCommandHandler: TaskHandler = async (context) => {
  const { acceptData, reject } = responder(context);
  const scope = taskScope(context);
  if (!scope) {
    reject(
      'async_run_command must target the originating app, agent, and conversation.',
      'forbidden',
    );
    return;
  }
  const service = taskService(context);
  if (!service) {
    reject('Async command runtime is unavailable.', 'unavailable');
    return;
  }
  const payload = context.data.payload ?? {};
  const command = toTrimmedString(payload.command, { maxLen: 20_000 });
  if (!command) {
    reject(
      'async_run_command requires a non-empty command.',
      'invalid_request',
    );
    return;
  }
  const { sandboxPolicy, ...scopedTaskOwner } = scope;
  const parentTask = await validateParentTaskScope(context, scopedTaskOwner);
  if (!parentTask.ok) {
    reject(parentTask.message, 'forbidden');
    return;
  }
  const result = await service.start({
    ...scopedTaskOwner,
    parentRunId: context.data.jobId ? null : (context.data.runId ?? null),
    parentTaskId: parentTask.parentTaskId,
    parentJobId: context.data.jobId ?? null,
    parentJobRunId: context.data.jobId ? (context.data.runId ?? null) : null,
    command,
    cwd: resolveWorkspaceFolderPath(context.sourceAgentFolder),
    protectedReadPaths: sandboxPolicy.protectedReadPaths,
    protectedWritePaths: sandboxPolicy.protectedWritePaths,
    allowedNetworkHosts: sandboxPolicy.allowedNetworkHosts,
    resourceLimits: sandboxPolicy.resourceLimits,
    memoryBlock: toTrimmedString(payload.memoryBlock, { maxLen: 100_000 }),
    allowedToolRules: await configuredAllowedTools(context, scopedTaskOwner),
    isScheduledJob: Boolean(context.data.jobId),
  });
  if (!result.ok) {
    reject(result.message, 'forbidden');
    return;
  }
  acceptData(`Queued: ${result.task.summary || result.task.id}`, result.task);
};

const taskGetHandler: TaskHandler = async (context) => {
  const { reject } = responder(context);
  const scope = taskScope(context);
  if (!scope) {
    reject(
      'task_get must target the originating app, agent, and conversation.',
      'forbidden',
    );
    return;
  }
  const service = taskService(context);
  if (!service) {
    reject('Async task runtime is unavailable.', 'unavailable');
    return;
  }
  const taskId = toTrimmedString(context.data.payload?.taskId, {
    maxLen: 160,
  });
  if (!taskId) {
    reject('task_get requires taskId.', 'invalid_request');
    return;
  }
  const { sandboxPolicy: _sandboxPolicy, ...scopedTaskOwner } = scope;
  const parentTask = await validateParentTaskScope(context, scopedTaskOwner);
  if (!parentTask.ok) {
    reject(parentTask.message, 'forbidden');
    return;
  }
  const tasks = taskBackend(context, service, scopedTaskOwner, parentTask);
  respondTaskLifecycleResult(context, await tasks.task_get({ taskId }));
};
const taskListHandler: TaskHandler = async (context) => {
  const { reject } = responder(context);
  const scope = taskScope(context);
  if (!scope) {
    reject(
      'task_list must target the originating app, agent, and conversation.',
      'forbidden',
    );
    return;
  }
  const service = taskService(context);
  if (!service) {
    reject('Async task runtime is unavailable.', 'unavailable');
    return;
  }
  const { sandboxPolicy: _sandboxPolicy, ...scopedTaskOwner } = scope;
  const parentTask = await validateParentTaskScope(context, scopedTaskOwner);
  if (!parentTask.ok) {
    reject(parentTask.message, 'forbidden');
    return;
  }
  const tasks = taskBackend(context, service, scopedTaskOwner, parentTask);
  respondTaskLifecycleResult(context, await tasks.task_list({}));
};
const taskCancelHandler: TaskHandler = async (context) => {
  const { reject } = responder(context);
  const scope = taskScope(context);
  if (!scope) {
    reject(
      'task_cancel must target the originating app, agent, and conversation.',
      'forbidden',
    );
    return;
  }
  const service = taskService(context);
  if (!service) {
    reject('Async task runtime is unavailable.', 'unavailable');
    return;
  }
  const taskId = toTrimmedString(context.data.payload?.taskId, {
    maxLen: 160,
  });
  if (!taskId) {
    reject('task_cancel requires taskId.', 'invalid_request');
    return;
  }
  const { sandboxPolicy: _sandboxPolicy, ...scopedTaskOwner } = scope;
  const parentTask = await validateParentTaskScope(context, scopedTaskOwner);
  if (!parentTask.ok) {
    reject(parentTask.message, 'forbidden');
    return;
  }
  const tasks = taskBackend(context, service, scopedTaskOwner, parentTask);
  respondTaskLifecycleResult(context, await tasks.task_cancel({ taskId }));
};
const delegateTaskHandler: TaskHandler = async (context) => {
  const { reject } = responder(context);
  const scope = taskScope(context);
  if (!scope) {
    reject(
      'delegate_task must target the originating app, agent, and conversation.',
      'forbidden',
    );
    return;
  }
  const service = taskService(context);
  if (!service) {
    reject('Async task runtime is unavailable.', 'unavailable');
    return;
  }
  if (context.data.parentTaskId) {
    reject(
      'delegate_task cannot be called from a delegated task.',
      'forbidden',
    );
    return;
  }
  const payload = context.data.payload ?? {};
  const objective = toTrimmedString(payload.objective, { maxLen: 10_000 });
  if (!objective) {
    reject('delegate_task requires an objective.', 'invalid_request');
    return;
  }
  const targetAgentId = toTrimmedString(payload.targetAgentId, { maxLen: 160 });
  const { sandboxPolicy: _sandboxPolicy, ...scopedTaskOwner } = scope;
  const target = await resolveDelegatedAgentTarget({
    deps: context.deps,
    routes: context.conversationBindings,
    owner: scopedTaskOwner,
    sourceAgentFolder: context.sourceAgentFolder,
    trustedProviderAccountId: scope.sandboxPolicy.providerAccountId,
    requestedProviderAccountId: context.data.providerAccountId,
    targetAgentId,
  });
  if (!target.ok) {
    reject(target.message, target.code);
    return;
  }
  const {
    group,
    targetOwner,
    toolPolicy,
    selectedSkillContext,
    semanticCapabilities,
    attachedMcpSourceIds,
  } = target;
  const sharedResult = await createCoreTaskLifecycleBackend({
    service,
    owner: { ...scopedTaskOwner, providerAccountId: target.providerAccountId },
    parentRunId: context.data.jobId ? null : (context.data.runId ?? null),
    workspaceFolder: group.folder,
    runDelegatedAgent: async ({
      task,
      prompt,
      signal,
      onProcessStarted,
      onProgress,
      timeoutMs: delegatedTimeoutMs,
    }) => {
      const runAgent = context.deps.runAgent ?? spawnAgent;
      let latestResult: string | null = null;
      let processHandlePersisted: Promise<void> | null = null;
      const output = await runAgent(
        group,
        {
          prompt,
          appId: scopedTaskOwner.appId,
          agentId: target.targetAgentId,
          chatJid: scopedTaskOwner.conversationId,
          threadId: scopedTaskOwner.threadId ?? undefined,
          workspaceFolder: group.folder,
          parentTaskId: task.id,
          persona: group.agentConfig?.persona,
          thinking: group.agentConfig?.thinking,
          toolPolicyRules: toolPolicy.toolPolicyRules,
          runtimeAccess: toolPolicy.runtimeAccess,
          attachedSkillSourceIds: selectedSkillContext.ids,
          selectedSkillDisplays: selectedSkillContext.displays,
          attachedMcpSourceIds,
          semanticCapabilities,
        },
        (proc) => {
          if (proc.pid) {
            processHandlePersisted = Promise.resolve(
              onProcessStarted?.({
                pid: proc.pid,
                processGroupId: proc.pid,
                detached: true,
                platform: process.platform,
                ownerPid: process.pid,
                startedAt: nowIso(),
              }),
            );
            processHandlePersisted.catch(() => {
              proc.kill('SIGTERM');
            });
          }
        },
        async (output: AgentOutput) => {
          if (output.result) {
            latestResult = output.result;
            await onProgress?.(output.result);
          }
        },
        {
          timeoutMs: delegatedTimeoutMs ?? DEFAULT_DELEGATED_AGENT_TIMEOUT_MS,
          signal,
          credentialBroker: await context.deps.getCredentialBroker?.(),
          skillRepository: context.deps.getSkillRepository?.(),
          skillArtifactStore: context.deps.getSkillArtifactStore?.(),
          skillContext: targetOwner,
          mcpServerRepository: context.deps.getMcpServerRepository?.(),
          capabilitySecretRepository:
            context.deps.getCapabilitySecretRepository?.(),
          mcpContext: targetOwner,
          mcpHostnameLookup: context.deps.mcpHostnameLookup,
          mcpDnsValidationCache: context.deps.getMcpDnsValidationCache?.(),
          publishRuntimeEvent: context.deps.publishRuntimeEvent,
          executionAdapter: context.deps.executionAdapter,
          executionAdapters: context.deps.executionAdapters,
          runnerSandboxProvider: context.deps.runnerSandboxProvider!,
          asyncTaskRepositoryAvailable: Boolean(
            context.deps.getAsyncTaskRepository?.(),
          ),
        },
      );
      if (processHandlePersisted) await processHandlePersisted;
      if (output.status === 'error') {
        return AsyncCommandTaskService.delegatedAgentFailureResult(
          output,
          latestResult,
          task.summary ?? 'Complete delegated task.',
        );
      }
      return {
        outputSummary:
          output.result ?? latestResult ?? 'delegated task completed',
      };
    },
  }).delegate_task({
    objective,
    ...(targetAgentId ? { targetAgentId } : {}),
    context: toTrimmedString(payload.context, { maxLen: 20_000 }) ?? undefined,
    expectedOutput:
      toTrimmedString(payload.expectedOutput, { maxLen: 2_000 }) ?? undefined,
    timeoutMs:
      typeof payload.timeoutMs === 'number'
        ? Math.min(payload.timeoutMs, DEFAULT_DELEGATED_AGENT_TIMEOUT_MS)
        : undefined,
  });
  respondTaskLifecycleResult(context, sharedResult);
};
const taskMessageHandler: TaskHandler = async (context) => {
  const { reject } = responder(context);
  const scope = taskScope(context);
  if (!scope) {
    reject(
      'task_message must target the originating app, agent, and conversation.',
      'forbidden',
    );
    return;
  }
  const service = taskService(context);
  if (!service) {
    reject('Async task runtime is unavailable.', 'unavailable');
    return;
  }
  const taskId = toTrimmedString(context.data.payload?.taskId, {
    maxLen: 160,
  });
  const message = toTrimmedString(context.data.payload?.message, {
    maxLen: 10_000,
  });
  if (!taskId || !message) {
    reject('task_message requires taskId and message.', 'invalid_request');
    return;
  }
  const { sandboxPolicy: _sandboxPolicy, ...scopedTaskOwner } = scope;
  const toolPolicy = await resolveTurnToolPolicy(context.deps, scopedTaskOwner);
  if (!toolPolicy.toolPolicyRules?.includes('AgentDelegation')) {
    reject('task_message requires AgentDelegation access.', 'forbidden');
    return;
  }
  const parentTask = await validateParentTaskScope(context, scopedTaskOwner);
  if (!parentTask.ok) {
    reject(parentTask.message, 'forbidden');
    return;
  }
  const tasks = taskBackend(
    context,
    service,
    scopedTaskOwner,
    parentTask,
    (task, text) => {
      const workspaceFolder =
        typeof task.privateCorrelationJson.workspaceFolder === 'string'
          ? task.privateCorrelationJson.workspaceFolder
          : context.sourceAgentFolder;
      writeContinuationInput(
        workspaceFolder,
        text,
        `${Date.now()}-${randomUUID()}`,
        taskContinuationThreadId(task.threadId, task.id),
      );
    },
  );
  respondTaskLifecycleResult(
    context,
    await tasks.task_message({ taskId, message }),
  );
};
export const agentTaskLifecycleHandlers: Record<string, TaskHandler> = {
  async_run_command: asyncRunCommandHandler,
  delegate_task: delegateTaskHandler,
  task_cancel: taskCancelHandler,
  task_get: taskGetHandler,
  task_list: taskListHandler,
  task_message: taskMessageHandler,
  todo_update: todoUpdateHandler,
};
