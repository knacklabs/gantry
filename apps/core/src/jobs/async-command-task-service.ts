import { randomUUID } from 'node:crypto';

import {
  type AsyncTaskCreateInput,
  type AgentFailureMetadata,
  type AsyncTaskKind,
  type AsyncTaskRecord,
  type AsyncTaskRepository,
  type AsyncTaskStatus,
  type PublicAsyncTaskDto,
  isAsyncTaskTerminal,
  toPublicAsyncTaskDto,
} from '../domain/ports/async-tasks.js';
import {
  sendDelegatedAgentTaskMessage,
  startDelegatedAgentTask,
  type StartDelegatedAgentTaskInput,
} from './async-delegated-agent-task.js';
import {
  ToolExecutionClassifier,
  ToolExecutionPolicyService,
} from '../shared/tool-execution-policy-service.js';
import type { RunnerSandboxResourceLimits } from '../shared/runner-sandbox-provider.js';
import { sanitizeOutboundLlmText } from '../shared/sensitive-material.js';
import { nowIso } from '../shared/time/datetime.js';
import {
  buildLaunchControl,
  cleanupLaunchControl,
  commandSummary,
  errorMessage,
  isTimeoutError,
  persistInspectionSnapshot,
  persistProcessHandle,
  readPersistedProcessHandle,
  taskInScope,
  taskTimestampMs,
  terminateProcessHandle,
  truncate,
  type AsyncCommandOutputSnapshot,
} from './async-command-task-helpers.js';
import {
  cancelledReceipt,
  failedReceipt,
} from './async-command-task-receipts.js';
import { cancelAsyncMcpTask } from './async-mcp-tool-task.js';
import {
  cancelQueuedTask,
  refreshDelegatedCancellationReceipt,
} from './async-task-cancellation.js';
import { asyncTaskChangeWaiterFor } from './async-task-change-waiter.js';
import type {
  AsyncCommandTaskServiceOptions,
  PendingAsyncTaskExecution,
} from './async-command-task-queue-types.js';
import { drainQueuedAsyncTasks } from './async-command-task-drainer.js';
import { asyncCommandPrivateCorrelation } from './async-task-execution-payload.js';
import { recoverQueuedAsyncTasks } from './async-command-queue-recovery.js';
import { createAdmittedAsyncTask } from './async-task-admission.js';
import { evaluateAsyncCommandStartPolicy } from './async-command-start-policy.js';
import {
  deliverPendingCallableAgentFollowUp,
  hasPendingCallableAgentFollowUp,
  isCallableAgentDelegatedTask,
  markCallableAgentAsyncFallback,
} from './async-delegated-agent-follow-up.js';
import { DELEGATED_TASK_LIST_PREVIEW_LIMIT } from '../shared/delegated-task-result-policy.js';

const MAX_ACTIVE_ASYNC_COMMANDS_PER_APP = 4;
const MAX_ACTIVE_ASYNC_COMMANDS_PER_AGENT = 2;
const ASYNC_TASK_HEARTBEAT_MS = 15_000;
export const ASYNC_TASK_STALE_AFTER_MS = 60_000;

export interface AsyncCommandLaunchControl {
  directory: string;
  pidFile: string;
  pgidFile: string;
  readyFile: string;
  continueFile: string;
}

export interface AsyncCommandRunnerResult {
  outputSummary?: string | null;
  errorSummary?: string | null;
  failure?: AgentFailureMetadata;
}

export interface AsyncCommandProcessHandle {
  pid: number;
  processGroupId?: number | null;
  detached: boolean;
  platform: NodeJS.Platform;
  ownerPid: number;
  startedAt: string;
  processStartId?: string;
}
export interface AsyncCommandRunner {
  run(input: {
    command: string;
    cwd?: string;
    signal: AbortSignal;
    appId: string;
    agentId: string;
    conversationId: string;
    threadId?: string | null;
    parentRunId?: string | null;
    parentJobId?: string | null;
    protectedReadPaths?: readonly string[];
    protectedWritePaths?: readonly string[];
    allowedNetworkHosts?: readonly string[];
    egressProxyUrl?: string;
    resourceLimits?: RunnerSandboxResourceLimits;
    onProcessStarted?: (
      handle: AsyncCommandProcessHandle,
    ) => Promise<void> | void;
    onOutputSnapshot?: (snapshot: AsyncCommandOutputSnapshot) => unknown;
    launchControl?: AsyncCommandLaunchControl;
  }): Promise<AsyncCommandRunnerResult>;
}
export interface StartAsyncCommandTaskInput {
  appId: string;
  agentId: string;
  conversationId: string;
  providerAccountId?: string | null;
  threadId?: string | null;
  parentRunId?: string | null;
  parentTaskId?: string | null;
  parentJobId?: string | null;
  parentJobRunId?: string | null;
  command: string;
  cwd?: string;
  protectedReadPaths?: readonly string[];
  protectedWritePaths?: readonly string[];
  allowedNetworkHosts?: readonly string[];
  egressProxyUrl?: string;
  resourceLimits?: RunnerSandboxResourceLimits;
  allowedToolRules: readonly string[];
  memoryBlock?: string;
  isScheduledJob?: boolean;
}

export type StartAsyncCommandTaskResult =
  { ok: true; task: PublicAsyncTaskDto } | { ok: false; message: string };

export class AsyncCommandTaskService {
  static delegatedAgentFailureResult(
    output: {
      result: string | null;
      error?: string;
      failure?: AgentFailureMetadata;
    },
    latestResult: string | null,
    attemptedAction: string,
  ): AsyncCommandRunnerResult {
    const partialResult = output.result ?? latestResult;
    return {
      outputSummary: partialResult,
      errorSummary: output.error ?? 'Delegated agent run failed.',
      failure: output.failure ?? {
        type: 'execution',
        attemptedAction,
        partialResult,
      },
    };
  }
  private readonly active = new Map<string, AbortController>();
  private readonly pending = new Map<string, PendingAsyncTaskExecution>();
  private readonly taskChanges;
  private readonly classifier = new ToolExecutionClassifier();
  private readonly policy = new ToolExecutionPolicyService();
  private readonly terminateProcess: (
    handle: AsyncCommandProcessHandle,
  ) => boolean;
  private readonly prepareRun: NonNullable<
    AsyncCommandTaskServiceOptions['prepareRun']
  >;
  private readonly createRecoveredDelegatedAgentRun:
    | AsyncCommandTaskServiceOptions['createRecoveredDelegatedAgentRun']
    | undefined;
  private readonly completionMessageRepository:
    AsyncCommandTaskServiceOptions['completionMessageRepository'] | undefined;

  constructor(
    private readonly repository: AsyncTaskRepository,
    private readonly runner: AsyncCommandRunner,
    options: AsyncCommandTaskServiceOptions = {},
  ) {
    this.taskChanges = asyncTaskChangeWaiterFor(repository);
    this.terminateProcess = options.terminateProcess ?? terminateProcessHandle;
    this.prepareRun = options.prepareRun ?? (async () => undefined);
    this.createRecoveredDelegatedAgentRun =
      options.createRecoveredDelegatedAgentRun;
    this.completionMessageRepository = options.completionMessageRepository;
  }

  async start(
    input: StartAsyncCommandTaskInput,
  ): Promise<StartAsyncCommandTaskResult> {
    const command = input.command.trim();
    if (!command) {
      return { ok: false, message: 'RunCommand requires a non-empty command.' };
    }
    const decision = evaluateAsyncCommandStartPolicy({
      command,
      conversationId: input.conversationId,
      threadId: input.threadId,
      parentJobId: input.parentJobId,
      allowedToolRules: input.allowedToolRules,
      memoryBlock: input.memoryBlock,
      isScheduledJob: input.isScheduledJob,
      classifier: this.classifier,
      policy: this.policy,
    });
    if (!decision.ok) return decision;
    await this.recoverStaleTasks({ appId: input.appId });
    const taskId = `task_${randomUUID()}`;
    const launchControl = buildLaunchControl(taskId);
    const controller = new AbortController();
    const redactedCommand = sanitizeOutboundLlmText(command).text;
    const createInput: AsyncTaskCreateInput = {
      id: taskId,
      appId: input.appId,
      agentId: input.agentId,
      conversationId: input.conversationId,
      threadId: input.threadId,
      parentRunId: input.parentRunId,
      parentJobId: input.parentJobId,
      parentJobRunId: input.parentJobRunId,
      kind: 'async_command',
      status: 'queued',
      admissionClass: 'task',
      authoritySnapshotJson: {
        matchedRule: decision.matchedRule,
        toolName: 'RunCommand',
      },
      privateCorrelationJson: asyncCommandPrivateCorrelation({
        appId: input.appId,
        taskId,
        command,
        launchControl,
        taskInput: input,
      }),
      leaseToken: randomUUID(),
      fencingVersion: 1,
      summary: commandSummary(redactedCommand),
      now: nowIso(),
    };
    const created = await createAdmittedAsyncTask({
      repository: this.repository,
      task: createInput,
    });
    if (!created.ok) return created;
    const task = created.task;
    this.pending.set(task.id, {
      task,
      command,
      input,
      controller,
      launchControl,
    });
    await this.drainQueuedTasks();
    return { ok: true, task: toPublicAsyncTaskDto(task) };
  }

  async startDelegatedAgent(input: StartDelegatedAgentTaskInput) {
    return startDelegatedAgentTask({
      taskInput: input,
      repository: this.repository,
      active: this.active,
      createTask: (createInput) => this.repository.createTask(createInput),
      queueTask: (execution) => {
        this.pending.set(execution.task.id, execution);
        void this.drainQueuedTasks();
      },
      recoverStaleTasks: (recoverInput) => this.recoverStaleTasks(recoverInput),
      cancelLinkedChildTasks: async (parent) => {
        const result = await this.cancelChildTasks(parent);
        return result.ok ? result.cancelled : 0;
      },
      waitForTaskChange: (_parent, options) => this.taskChanges.wait(options),
      transitionTask: (transition) => this.transitionTask(transition),
    });
  }
  private async transitionTask(
    input: Parameters<AsyncTaskRepository['transitionTask']>[0],
  ): ReturnType<AsyncTaskRepository['transitionTask']> {
    const updated = await this.repository.transitionTask(input);
    if (updated) {
      this.taskChanges.notify();
      if (
        updated.kind === 'delegated_agent' &&
        isAsyncTaskTerminal(updated.status)
      ) {
        this.taskChanges.notifyCompletion(delegatedCompletion(updated));
        await deliverPendingCallableAgentFollowUp({
          task: updated,
          repository: this.repository,
          messageRepository: this.completionMessageRepository,
        }).catch(() => false);
      }
    }
    return updated;
  }
  async markDelegatedTaskAsyncFallback(input: {
    taskId: string;
    appId: string;
    agentId: string;
    conversationId?: string | null;
    providerAccountId?: string | null;
    threadId?: string | null;
  }) {
    const task = await this.repository.getTask(input.taskId);
    if (!task || !taskInScope(task, input)) {
      throw new Error('Delegated task not found before async fallback.');
    }
    if (!isCallableAgentDelegatedTask(task)) {
      throw new Error('Async follow-up is only available for callable agents.');
    }
    const marked = await markCallableAgentAsyncFallback({
      repository: this.repository,
      task,
    });
    if (!isAsyncTaskTerminal(marked.status)) return null;
    return hasPendingCallableAgentFollowUp(marked)
      ? null
      : delegatedCompletion(marked);
  }
  async get(taskId: string): Promise<PublicAsyncTaskDto | null> {
    const task = await this.repository.getTask(taskId);
    return task && isAgentFacingTask(task) ? toPublicAsyncTaskDto(task) : null;
  }
  async getScoped(input: {
    taskId: string;
    appId: string;
    agentId: string;
    conversationId?: string | null;
    providerAccountId?: string | null;
    threadId?: string | null;
    parentTaskId?: string | null;
  }): Promise<PublicAsyncTaskDto | null> {
    const task = await this.repository.getTask(input.taskId);
    return task && isAgentFacingTask(task) && taskInScope(task, input)
      ? toPublicAsyncTaskDto(task)
      : null;
  }
  async list(input: {
    appId: string;
    agentId?: string;
    conversationId?: string | null;
    providerAccountId?: string | null;
    threadId?: string | null;
    parentRunId?: string | null;
    parentTaskId?: string | null;
    limit?: number;
  }): Promise<PublicAsyncTaskDto[]> {
    const tasks = await this.repository.listTasks(input);
    return tasks
      .filter((task) => isAgentFacingTask(task) && taskInScope(task, input))
      .map((task) => {
        const dto = toPublicAsyncTaskDto(task);
        return task.kind === 'delegated_agent' && dto.outputSummary
          ? {
              ...dto,
              outputSummary: truncate(
                dto.outputSummary,
                DELEGATED_TASK_LIST_PREVIEW_LIMIT,
              ),
            }
          : dto;
      });
  }
  async message(input: {
    taskId: string;
    appId: string;
    agentId: string;
    conversationId?: string | null;
    providerAccountId?: string | null;
    threadId?: string | null;
    parentTaskId?: string | null;
    message: string;
    deliver: (task: AsyncTaskRecord, message: string) => Promise<void> | void;
  }): Promise<{ ok: boolean; message: string }> {
    return sendDelegatedAgentTaskMessage({
      ...input,
      repository: this.repository,
    });
  }

  async recoverStaleTasks(input: {
    appId: string;
    agentId?: string;
    staleAfterMs?: number;
    limit?: number;
    excludeKinds?: AsyncTaskKind[];
  }): Promise<number> {
    await this.recoverPendingDelegatedAgentFollowUps(input);
    const staleBefore =
      Date.now() - (input.staleAfterMs ?? ASYNC_TASK_STALE_AFTER_MS);
    const tasks = await this.repository.listTasks({
      ...input,
      statuses: ['running', 'needs_attention'],
      limit: input.limit ?? 100,
    });
    const excludeKinds = new Set(input.excludeKinds ?? []);
    let recovered = 0;
    for (const task of tasks) {
      if (excludeKinds.has(task.kind)) continue;
      if (taskTimestampMs(task) > staleBefore) continue;
      const handle = readPersistedProcessHandle(task.privateCorrelationJson);
      if (!handle && task.status === 'running') {
        const now = nowIso();
        if (task.kind === 'delegated_agent') await this.cancelChildTasks(task);
        const updated = await this.transitionTask({
          taskId: task.id,
          leaseToken: task.leaseToken,
          fencingVersion: task.fencingVersion,
          status: 'failed',
          now,
          terminalAt: now,
          errorSummary:
            'Task worker stopped before Gantry could recover a process handle.',
          receiptJson: failedReceipt(
            task,
            'failed after worker stopped before process handle recovery',
          ),
        });
        if (updated) recovered += 1;
        continue;
      }
      const now = nowIso();
      if (task.kind === 'delegated_agent') await this.cancelChildTasks(task);
      const updated = await this.transitionTask({
        taskId: task.id,
        leaseToken: task.leaseToken,
        fencingVersion: task.fencingVersion,
        status: 'failed',
        now,
        terminalAt: now,
        errorSummary:
          'Task recovered after its worker stopped heartbeating; any tracked process was terminated.',
        receiptJson: failedReceipt(
          task,
          'failed after worker heartbeat expired',
        ),
      });
      if (updated) {
        if (handle) this.terminateProcess(handle);
        recovered += 1;
      }
    }
    return recovered;
  }
  async recoverQueuedTasks(input: {
    appId: string;
    agentId?: string;
    limit?: number;
  }): Promise<number> {
    const recovered = await recoverQueuedAsyncTasks({
      repository: this.repository,
      pending: this.pending,
      createDelegatedRun: this.createRecoveredDelegatedAgentRun,
      cancelLinkedChildTasks: async (parent) => {
        const result = await this.cancelChildTasks(parent);
        return result.ok ? result.cancelled : 0;
      },
      waitForTaskChange: (_parent, options) => this.taskChanges.wait(options),
      transitionTask: (transition) => this.transitionTask(transition),
      ...input,
    });
    if (recovered > 0) await this.drainQueuedTasks();
    return recovered;
  }
  async cancel(
    input:
      | string
      | {
          taskId: string;
          appId?: string;
          agentId?: string;
          conversationId?: string | null;
          providerAccountId?: string | null;
          threadId?: string | null;
          parentTaskId?: string | null;
        },
  ): Promise<{ ok: boolean; message: string }> {
    const taskId = typeof input === 'string' ? input : input.taskId;
    const task = await this.repository.getTask(taskId);
    if (!task || !isAgentFacingTask(task)) {
      return { ok: false, message: 'Task not found.' };
    }
    if (
      typeof input !== 'string' &&
      !taskInScope(task, {
        appId: input.appId ?? task.appId,
        agentId: input.agentId ?? task.agentId,
        conversationId: input.conversationId,
        providerAccountId: input.providerAccountId,
        threadId: input.threadId,
        parentTaskId: input.parentTaskId,
      })
    ) {
      return { ok: false, message: 'Task not found.' };
    }
    if (isAsyncTaskTerminal(task.status)) {
      return {
        ok: false,
        message: 'Task is already finished and cannot be cancelled.',
      };
    }
    const controller = this.active.get(taskId);
    if (!controller) {
      if (task.kind === 'mcp_tool_call') {
        return cancelAsyncMcpTask(this.repository, task);
      }
      if (task.status === 'queued') {
        this.pending.delete(taskId);
        return cancelQueuedTask({
          repository: this.repository,
          task,
          transitionTask: (transition) => this.transitionTask(transition),
        });
      }
      const handle = readPersistedProcessHandle(task.privateCorrelationJson);
      if (handle) {
        const now = nowIso();
        const cancelled = await this.transitionTask({
          taskId,
          leaseToken: task.leaseToken,
          fencingVersion: task.fencingVersion,
          status: 'cancelled',
          now,
          terminalAt: now,
          receiptJson: cancelledReceipt(task),
        });
        if (cancelled) {
          this.terminateProcess(handle);
          if (task.kind === 'delegated_agent') {
            const childCancellation = await this.cancelChildTasks(task);
            if (!childCancellation.ok) {
              return { ok: false, message: childCancellation.message };
            }
            await refreshDelegatedCancellationReceipt({
              repository: this.repository,
              parent: task,
              alreadyCancelled: childCancellation.cancelled,
              cancelChildTasks: (parent) => this.cancelChildTasks(parent),
            });
          }
          return {
            ok: true,
            message: 'Task was cancelled. Nothing else changed.',
          };
        }
      }
      return {
        ok: false,
        message:
          'Task has no recoverable process handle. Wait for stale-task recovery before starting or cancelling it again.',
      };
    }
    const now = nowIso();
    const cancelled = await this.transitionTask({
      taskId,
      leaseToken: task.leaseToken,
      fencingVersion: task.fencingVersion,
      status: 'cancelled',
      now,
      terminalAt: now,
      receiptJson: cancelledReceipt(task),
    });
    if (!cancelled) {
      return {
        ok: false,
        message: 'Task is already finished and cannot be cancelled.',
      };
    }
    controller.abort();
    const latest = await this.repository.getTask(taskId);
    const handle = latest
      ? readPersistedProcessHandle(latest.privateCorrelationJson)
      : null;
    if (handle) this.terminateProcess(handle);
    if (task.kind === 'delegated_agent') {
      const childCancellation = await this.cancelChildTasks(task);
      if (!childCancellation.ok) {
        return { ok: false, message: childCancellation.message };
      }
      await refreshDelegatedCancellationReceipt({
        repository: this.repository,
        parent: task,
        alreadyCancelled: childCancellation.cancelled,
        cancelChildTasks: (parent) => this.cancelChildTasks(parent),
      });
    }
    return { ok: true, message: 'Task was cancelled. Nothing else changed.' };
  }
  private async cancelChildTasks(
    parent: AsyncTaskRecord,
  ): Promise<{ ok: true; cancelled: number } | { ok: false; message: string }> {
    let cancelled = 0;
    for (;;) {
      const tasks = await this.repository.listTasks({
        appId: parent.appId,
        parentTaskId: parent.id,
        statuses: ['queued', 'running', 'needs_attention'],
        limit: 100,
      });
      if (tasks.length === 0) break;
      for (const child of tasks) {
        if (child.id === parent.id) continue;
        const result = await this.cancel(child.id);
        if (result.ok) cancelled += 1;
        else {
          return {
            ok: false,
            message: `Could not cancel child task ${child.id}: ${result.message}`,
          };
        }
      }
    }
    return { ok: true, cancelled };
  }
  private async execute(
    task: AsyncTaskRecord,
    command: string,
    input: Pick<
      StartAsyncCommandTaskInput,
      | 'cwd'
      | 'protectedReadPaths'
      | 'protectedWritePaths'
      | 'allowedNetworkHosts'
      | 'egressProxyUrl'
      | 'resourceLimits'
    >,
    controller: AbortController,
    launchControl: AsyncCommandLaunchControl,
  ): Promise<void> {
    const startedAt = nowIso();
    const running = await this.transitionTask({
      taskId: task.id,
      leaseToken: task.leaseToken,
      fencingVersion: task.fencingVersion,
      status: 'running',
      now: startedAt,
      startedAt,
      heartbeatAt: startedAt,
    });
    if (!running) {
      this.active.delete(task.id);
      return;
    }
    const heartbeat = setInterval(() => {
      void this.transitionTask({
        taskId: task.id,
        leaseToken: task.leaseToken,
        fencingVersion: task.fencingVersion,
        status: 'running',
        now: nowIso(),
        heartbeatAt: nowIso(),
      });
    }, ASYNC_TASK_HEARTBEAT_MS);
    heartbeat.unref?.();
    let preparedRun:
      | {
          egressProxyUrl?: string;
          cleanup?: () => Promise<void> | void;
        }
      | undefined;
    try {
      preparedRun = await this.prepareRun({
        task,
        allowedNetworkHosts: input.allowedNetworkHosts,
      });
      const result = await this.runner.run({
        command,
        cwd: input.cwd,
        protectedReadPaths: input.protectedReadPaths,
        protectedWritePaths: input.protectedWritePaths,
        allowedNetworkHosts: input.allowedNetworkHosts,
        egressProxyUrl: preparedRun?.egressProxyUrl ?? input.egressProxyUrl,
        resourceLimits: input.resourceLimits,
        signal: controller.signal,
        launchControl,
        onOutputSnapshot: (snapshot) =>
          persistInspectionSnapshot({
            repository: this.repository,
            task,
            snapshot,
          }),
        onProcessStarted: (handle) =>
          persistProcessHandle({ repository: this.repository, task, handle }),
        appId: task.appId,
        agentId: task.agentId,
        conversationId: task.conversationId ?? '',
        threadId: task.threadId,
        parentRunId: task.parentRunId,
        parentJobId: task.parentJobId,
      });
      const now = nowIso();
      await this.transitionTask({
        taskId: task.id,
        leaseToken: task.leaseToken,
        fencingVersion: task.fencingVersion,
        status: 'completed',
        now,
        terminalAt: now,
        outputSummary: truncate(result.outputSummary ?? ''),
        errorSummary: truncate(result.errorSummary ?? ''),
        receiptJson: {
          completed: truncate(result.outputSummary || 'command completed'),
          used: 'RunCommand',
          changed: 'none',
          delegated: 'no',
          needsAttention: 'none',
        },
      });
    } catch (err) {
      const now = nowIso();
      const aborted = controller.signal.aborted;
      const timedOut = isTimeoutError(err);
      await this.transitionTask({
        taskId: task.id,
        leaseToken: task.leaseToken,
        fencingVersion: task.fencingVersion,
        status: aborted ? 'cancelled' : timedOut ? 'timed_out' : 'failed',
        now,
        terminalAt: now,
        errorSummary: errorMessage(err),
        receiptJson: {
          completed: aborted ? 'cancelled' : timedOut ? 'timed out' : 'failed',
          used: 'RunCommand',
          changed: 'none',
          delegated: 'no',
          needsAttention: aborted ? 'none' : errorMessage(err),
        },
      });
    } finally {
      clearInterval(heartbeat);
      this.active.delete(task.id);
      cleanupLaunchControl(launchControl);
      try {
        await preparedRun?.cleanup?.();
      } catch {
        // Task already reached a terminal state; cleanup failures are not user-visible task output.
      }
      void this.drainQueuedTasks();
    }
  }
  private async drainQueuedTasks(): Promise<void> {
    await drainQueuedAsyncTasks({
      repository: this.repository,
      pending: this.pending,
      active: this.active,
      limits: {
        perApp: MAX_ACTIVE_ASYNC_COMMANDS_PER_APP,
        perAgent: MAX_ACTIVE_ASYNC_COMMANDS_PER_AGENT,
      },
      executeCommand: (task, command, input, controller, launchControl) =>
        this.execute(task, command, input, controller, launchControl),
    });
  }

  async recoverPendingDelegatedAgentFollowUps(input: {
    appId: string;
    agentId?: string;
    limit?: number;
  }): Promise<number> {
    if (!this.completionMessageRepository) return 0;
    const tasks = await this.repository.listTasks({
      ...input,
      kind: 'delegated_agent',
      statuses: ['completed', 'failed', 'cancelled', 'timed_out'],
      order: 'newest_first',
      limit: input.limit ?? 100,
    });
    let delivered = 0;
    for (const task of tasks) {
      if (
        await deliverPendingCallableAgentFollowUp({
          task,
          repository: this.repository,
          messageRepository: this.completionMessageRepository,
        }).catch(() => false)
      ) {
        delivered += 1;
      }
    }
    return delivered;
  }
}

function isAgentFacingTask(task: AsyncTaskRecord): boolean {
  return task.kind !== 'session_compaction';
}

function delegatedCompletion(task: AsyncTaskRecord): {
  taskId: string;
  status: Extract<
    AsyncTaskStatus,
    'completed' | 'cancelled' | 'timed_out' | 'failed'
  >;
  result: string;
  error?: string;
} {
  const status = task.status;
  if (!isAsyncTaskTerminal(status)) {
    throw new Error(`Delegated task ${task.id} is not terminal.`);
  }
  return {
    taskId: task.id,
    status: status as Extract<
      AsyncTaskStatus,
      'completed' | 'cancelled' | 'timed_out' | 'failed'
    >,
    result: task.outputSummary || `delegated task ${status}`,
    ...(task.errorSummary ? { error: task.errorSummary } : {}),
  };
}
