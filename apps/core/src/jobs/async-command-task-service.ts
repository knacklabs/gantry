import { randomUUID } from 'node:crypto';

import {
  type AsyncTaskCreateInput,
  type AsyncTaskRecord,
  type AsyncTaskRepository,
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
  buildAgentToolExecutionRequest,
  evaluateProtectedCapabilityToolUse,
  ToolExecutionClassifier,
  ToolExecutionPolicyService,
} from '../shared/tool-execution-policy-service.js';
import { denyMemoryBoundaryToolUse } from '../shared/memory-boundary.js';
import { sanitizeOutboundLlmText } from '../shared/sensitive-material.js';
import { nowIso } from '../shared/time/datetime.js';
import {
  admissionFailure,
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
  withLocalAdmissionLock,
  type AsyncCommandOutputSnapshot,
} from './async-command-task-helpers.js';
import {
  cancelledReceipt,
  failedReceipt,
} from './async-command-task-receipts.js';
import { cancelAsyncMcpTask } from './async-mcp-tool-task.js';
import { refreshDelegatedCancellationReceipt } from './async-task-cancellation.js';

const SHELL_POLICY_TOOL_NAME = 'Bash';
const ACTIVE_TASK_STATUSES: AsyncTaskRecord['status'][] = ['queued', 'running'];
const MAX_ACTIVE_ASYNC_COMMANDS_PER_APP = 4,
  MAX_ACTIVE_ASYNC_COMMANDS_PER_AGENT = 2;
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
    resourceLimits?: {
      cpuSeconds: number;
      memoryMb: number;
      maxProcesses: number;
    };
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
  resourceLimits?: {
    cpuSeconds: number;
    memoryMb: number;
    maxProcesses: number;
  };
  allowedToolRules: readonly string[];
  memoryBlock?: string;
  isScheduledJob?: boolean;
}

export type StartAsyncCommandTaskResult =
  | { ok: true; task: PublicAsyncTaskDto }
  | { ok: false; message: string };

export interface AsyncCommandTaskServiceOptions {
  terminateProcess?: (handle: AsyncCommandProcessHandle) => boolean;
  prepareRun?: (input: {
    task: AsyncTaskRecord;
    allowedNetworkHosts?: readonly string[];
  }) => Promise<
    | {
        egressProxyUrl?: string;
        cleanup?: () => Promise<void> | void;
      }
    | undefined
  >;
}

export class AsyncCommandTaskService {
  private readonly active = new Map<string, AbortController>();
  private readonly classifier = new ToolExecutionClassifier();
  private readonly policy = new ToolExecutionPolicyService();
  private readonly terminateProcess: (
    handle: AsyncCommandProcessHandle,
  ) => boolean;
  private readonly prepareRun: NonNullable<
    AsyncCommandTaskServiceOptions['prepareRun']
  >;

  constructor(
    private readonly repository: AsyncTaskRepository,
    private readonly runner: AsyncCommandRunner,
    options: AsyncCommandTaskServiceOptions = {},
  ) {
    this.terminateProcess = options.terminateProcess ?? terminateProcessHandle;
    this.prepareRun = options.prepareRun ?? (async () => undefined);
  }

  async start(
    input: StartAsyncCommandTaskInput,
  ): Promise<StartAsyncCommandTaskResult> {
    const command = input.command.trim();
    if (!command) {
      return { ok: false, message: 'RunCommand requires a non-empty command.' };
    }
    const policyInput = { command };
    const protectedDenial = evaluateProtectedCapabilityToolUse(
      SHELL_POLICY_TOOL_NAME,
      policyInput,
    );
    if (protectedDenial) {
      return {
        ok: false,
        message: `Denied by Gantry tool execution policy: ${protectedDenial.reason} ${protectedDenial.recoveryAction}`,
      };
    }
    const memoryDenial = denyMemoryBoundaryToolUse(
      SHELL_POLICY_TOOL_NAME,
      policyInput,
      {},
      input.memoryBlock ?? '',
    );
    if (memoryDenial) return { ok: false, message: memoryDenial };

    const request = buildAgentToolExecutionRequest(
      this.classifier,
      SHELL_POLICY_TOOL_NAME,
      policyInput,
      {
        conversationId: input.conversationId,
        threadId: input.threadId ?? undefined,
        jobId: input.parentJobId ?? undefined,
        isScheduledJob: input.isScheduledJob,
      },
    );
    const decision = this.policy.evaluate({
      request,
      ...(input.isScheduledJob
        ? { autonomousAllowedToolRules: input.allowedToolRules }
        : { allowedToolRules: input.allowedToolRules }),
    });
    if (decision.status !== 'allow') {
      return {
        ok: false,
        message:
          'This command is not approved for this agent. Request access or choose an approved capability.',
      };
    }
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
      privateCorrelationJson: {
        cwd: input.cwd ?? null,
        parentTaskId: input.parentTaskId ?? null,
        launch: launchControl,
      },
      leaseToken: randomUUID(),
      fencingVersion: 1,
      summary: commandSummary(redactedCommand),
      now: nowIso(),
    };
    const admitted = await this.admitTask(createInput);
    if (!admitted.ok) return admissionFailure(admitted.reason);
    const task = admitted.task;

    this.active.set(task.id, controller);
    void this.execute(task, command, input, controller, launchControl);
    return { ok: true, task: toPublicAsyncTaskDto(task) };
  }

  async startDelegatedAgent(input: StartDelegatedAgentTaskInput) {
    return startDelegatedAgentTask({
      taskInput: input,
      repository: this.repository,
      active: this.active,
      admitTask: (createInput) => this.admitTask(createInput),
      recoverStaleTasks: (recoverInput) => this.recoverStaleTasks(recoverInput),
      cancelLinkedChildTasks: async (parent) => {
        const result = await this.cancelChildTasks(parent);
        return result.ok ? result.cancelled : 0;
      },
    });
  }

  private async admitTask(
    input: AsyncTaskCreateInput,
  ): Promise<
    | { ok: true; task: AsyncTaskRecord }
    | { ok: false; reason: 'app_capacity' | 'agent_capacity' }
  > {
    if (this.repository.createTaskWithAdmission) {
      return this.repository.createTaskWithAdmission(input, {
        activeStatuses: ACTIVE_TASK_STATUSES,
        kind: input.kind,
        maxActivePerApp: MAX_ACTIVE_ASYNC_COMMANDS_PER_APP,
        maxActivePerAgent: MAX_ACTIVE_ASYNC_COMMANDS_PER_AGENT,
      });
    }
    return withLocalAdmissionLock(this.repository, async () => {
      const [appActive, agentActive] = await Promise.all([
        this.repository.listTasks({
          appId: input.appId,
          kind: input.kind,
          statuses: ACTIVE_TASK_STATUSES,
          limit: MAX_ACTIVE_ASYNC_COMMANDS_PER_APP,
        }),
        this.repository.listTasks({
          appId: input.appId,
          agentId: input.agentId,
          kind: input.kind,
          statuses: ACTIVE_TASK_STATUSES,
          limit: MAX_ACTIVE_ASYNC_COMMANDS_PER_AGENT,
        }),
      ]);
      if (appActive.length >= MAX_ACTIVE_ASYNC_COMMANDS_PER_APP) {
        return { ok: false, reason: 'app_capacity' };
      }
      if (agentActive.length >= MAX_ACTIVE_ASYNC_COMMANDS_PER_AGENT) {
        return { ok: false, reason: 'agent_capacity' };
      }
      return { ok: true, task: await this.repository.createTask(input) };
    });
  }

  async get(taskId: string): Promise<PublicAsyncTaskDto | null> {
    const task = await this.repository.getTask(taskId);
    return task ? toPublicAsyncTaskDto(task) : null;
  }

  async getScoped(input: {
    taskId: string;
    appId: string;
    agentId: string;
    conversationId?: string | null;
    threadId?: string | null;
    parentTaskId?: string | null;
  }): Promise<PublicAsyncTaskDto | null> {
    const task = await this.repository.getTask(input.taskId);
    return task && taskInScope(task, input) ? toPublicAsyncTaskDto(task) : null;
  }

  async list(input: {
    appId: string;
    agentId?: string;
    conversationId?: string | null;
    threadId?: string | null;
    parentRunId?: string | null;
    parentTaskId?: string | null;
    limit?: number;
  }): Promise<PublicAsyncTaskDto[]> {
    const tasks = await this.repository.listTasks(input);
    return tasks.map(toPublicAsyncTaskDto);
  }

  async message(input: {
    taskId: string;
    appId: string;
    agentId: string;
    conversationId?: string | null;
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
  }): Promise<number> {
    const staleBefore =
      Date.now() - (input.staleAfterMs ?? ASYNC_TASK_STALE_AFTER_MS);
    const tasks = await this.repository.listTasks({
      ...input,
      statuses: ['queued', 'running', 'needs_attention'],
      limit: input.limit ?? 100,
    });
    let recovered = 0;
    for (const task of tasks) {
      if (taskTimestampMs(task) > staleBefore) continue;
      const handle = readPersistedProcessHandle(task.privateCorrelationJson);
      if (!handle && task.status === 'running') {
        const now = nowIso();
        if (task.kind === 'delegated_agent') await this.cancelChildTasks(task);
        const updated = await this.repository.transitionTask({
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
      const updated = await this.repository.transitionTask({
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

  async cancel(
    input:
      | string
      | {
          taskId: string;
          appId?: string;
          agentId?: string;
          conversationId?: string | null;
          threadId?: string | null;
          parentTaskId?: string | null;
        },
  ): Promise<{ ok: boolean; message: string }> {
    const taskId = typeof input === 'string' ? input : input.taskId;
    const task = await this.repository.getTask(taskId);
    if (!task) return { ok: false, message: 'Task not found.' };
    if (
      typeof input !== 'string' &&
      !taskInScope(task, {
        appId: input.appId ?? task.appId,
        agentId: input.agentId ?? task.agentId,
        conversationId: input.conversationId,
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
      const handle = readPersistedProcessHandle(task.privateCorrelationJson);
      if (handle) {
        const now = nowIso();
        const cancelled = await this.repository.transitionTask({
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
    const cancelled = await this.repository.transitionTask({
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
        agentId: parent.agentId,
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
    const running = await this.repository.transitionTask({
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
      void this.repository.transitionTask({
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
      await this.repository.transitionTask({
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
      await this.repository.transitionTask({
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
    }
  }
}
