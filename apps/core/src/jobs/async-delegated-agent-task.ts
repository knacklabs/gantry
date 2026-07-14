import { randomUUID } from 'node:crypto';

import {
  type AgentFailureMetadata,
  type AsyncTaskCreateInput,
  type AsyncTaskRecord,
  type AsyncTaskRepository,
  type AsyncTaskStatusCount,
  isAsyncTaskTerminal,
  toPublicAsyncTaskDto,
} from '../domain/ports/async-tasks.js';
import { nowIso } from '../shared/time/datetime.js';
import {
  commandSummary,
  errorMessage,
  isTimeoutError,
  taskInScope,
  truncate,
} from './async-command-task-helpers.js';
import {
  type AsyncCommandProcessHandle,
  type AsyncCommandRunnerResult,
  type StartAsyncCommandTaskResult,
} from './async-command-task-service.js';
import { asyncDelegatedPrivateCorrelation } from './async-task-execution-payload.js';
import { createAdmittedAsyncTask } from './async-task-admission.js';
import { notifyAsyncTaskChange } from './async-task-change-waiter.js';

const ASYNC_TASK_HEARTBEAT_MS = 15_000;
const ASYNC_TASK_WAKE_FALLBACK_MS = 15_000;

class DelegatedChildFailureError extends Error {
  constructor(
    readonly subtasks: string,
    readonly failure: AgentFailureMetadata,
    readonly terminalChildren: ReturnType<typeof toPublicAsyncTaskDto>[],
  ) {
    super(failure.attemptedAction);
  }
}

export interface StartDelegatedAgentTaskInput {
  appId: string;
  agentId: string;
  conversationId: string;
  providerAccountId?: string | null;
  threadId?: string | null;
  parentRunId?: string | null;
  objective: string;
  context?: string | null;
  expectedOutput?: string | null;
  targetAgentId?: string;
  workspaceFolder: string;
  run(input: {
    task: AsyncTaskRecord;
    prompt: string;
    targetAgentId?: string;
    signal: AbortSignal;
    onProcessStarted?: (
      handle: AsyncCommandProcessHandle,
    ) => Promise<void> | void;
    onProgress?: (summary: string) => Promise<void> | void;
  }): Promise<AsyncCommandRunnerResult>;
}

export type StartDelegatedAgentTaskResult = StartAsyncCommandTaskResult;

export type PendingDelegatedAgentExecution = {
  task: AsyncTaskRecord;
  command: string;
  input: never;
  controller: AbortController;
  launchControl: never;
  delegated: {
    taskInput: StartDelegatedAgentTaskInput;
    cancelLinkedChildTasks: (parent: AsyncTaskRecord) => Promise<number>;
    waitForTaskChange?: (
      parent: AsyncTaskRecord,
      options: { signal: AbortSignal; timeoutMs: number },
    ) => Promise<void>;
  };
};

export async function startDelegatedAgentTask(input: {
  taskInput: StartDelegatedAgentTaskInput;
  repository: AsyncTaskRepository;
  active: Map<string, AbortController>;
  createTask: (input: AsyncTaskCreateInput) => Promise<AsyncTaskRecord>;
  queueTask: (execution: PendingDelegatedAgentExecution) => void;
  recoverStaleTasks: (input: { appId: string }) => Promise<number>;
  cancelLinkedChildTasks: (parent: AsyncTaskRecord) => Promise<number>;
  waitForTaskChange?: (
    parent: AsyncTaskRecord,
    options: { signal: AbortSignal; timeoutMs: number },
  ) => Promise<void>;
}): Promise<StartDelegatedAgentTaskResult> {
  const objective = input.taskInput.objective.trim();
  if (!objective) {
    return { ok: false, message: 'delegate_task requires an objective.' };
  }
  await input.recoverStaleTasks({ appId: input.taskInput.appId });
  const taskId = `task_${randomUUID()}`;
  const controller = new AbortController();
  const createInput: AsyncTaskCreateInput = {
    id: taskId,
    appId: input.taskInput.appId,
    agentId: input.taskInput.agentId,
    conversationId: input.taskInput.conversationId,
    threadId: input.taskInput.threadId,
    parentRunId: input.taskInput.parentRunId,
    kind: 'delegated_agent',
    status: 'queued',
    admissionClass: 'task',
    authoritySnapshotJson: { toolName: 'delegate_task', maxDepth: 1 },
    privateCorrelationJson: asyncDelegatedPrivateCorrelation({
      appId: input.taskInput.appId,
      taskId,
      taskInput: input.taskInput,
    }),
    leaseToken: randomUUID(),
    fencingVersion: 1,
    summary: commandSummary(objective),
    now: nowIso(),
  };
  const created = await createAdmittedAsyncTask({
    repository: input.repository,
    task: createInput,
  });
  if (!created.ok) return created;
  const task = created.task;
  input.queueTask({
    task,
    command: '',
    input: undefined as never,
    controller,
    launchControl: undefined as never,
    delegated: {
      taskInput: input.taskInput,
      cancelLinkedChildTasks: input.cancelLinkedChildTasks,
      waitForTaskChange: input.waitForTaskChange,
    },
  });
  return { ok: true, task: toPublicAsyncTaskDto(task) };
}

export async function sendDelegatedAgentTaskMessage(input: {
  taskId: string;
  appId: string;
  agentId: string;
  conversationId?: string | null;
  providerAccountId?: string | null;
  threadId?: string | null;
  parentTaskId?: string | null;
  message: string;
  repository: AsyncTaskRepository;
  deliver: (task: AsyncTaskRecord, message: string) => Promise<void> | void;
}): Promise<{ ok: boolean; message: string }> {
  const message = input.message.trim();
  if (!message) return { ok: false, message: 'task_message requires message.' };
  const task = await input.repository.getTask(input.taskId);
  if (!task || !taskInScope(task, input)) {
    return { ok: false, message: 'Task not found.' };
  }
  if (task.kind !== 'delegated_agent') {
    return {
      ok: false,
      message: 'task_message is only available for delegated agent tasks.',
    };
  }
  if (isAsyncTaskTerminal(task.status)) {
    return {
      ok: false,
      message: 'Task is already finished and cannot receive messages.',
    };
  }
  const progress = task.privateCorrelationJson.progress;
  if (isRecordValue(progress) && progress.childRunnerActive === false) {
    return {
      ok: false,
      message: 'Delegated agent has finished and cannot receive messages.',
    };
  }
  const steeringId = `steer_${randomUUID()}`;
  const withPending = await appendSteeringMessage(input.repository, task, {
    id: steeringId,
    status: 'pending',
    message: truncate(message, 1_000),
    createdAt: nowIso(),
  });
  if (!withPending) {
    return {
      ok: false,
      message: 'Task is already finished and cannot receive messages.',
    };
  }
  const latest = await input.repository.getTask(input.taskId);
  const latestProgress = latest?.privateCorrelationJson.progress;
  if (
    !latest ||
    isAsyncTaskTerminal(latest.status) ||
    (isRecordValue(latestProgress) &&
      latestProgress.childRunnerActive === false)
  ) {
    await updateSteering(input.repository, withPending, steeringId, {
      status: 'rejected',
      rejectedAt: nowIso(),
      reason: 'Task is already finished and cannot receive messages.',
    });
    return {
      ok: false,
      message: 'Task is already finished and cannot receive messages.',
    };
  }
  try {
    await input.deliver(latest, message);
    await updateSteering(input.repository, latest, steeringId, {
      status: 'consumed',
      consumedAt: nowIso(),
    });
    return { ok: true, message: 'Message sent to delegated task.' };
  } catch (err) {
    await updateSteering(input.repository, latest, steeringId, {
      status: 'rejected',
      rejectedAt: nowIso(),
      reason: errorMessage(err),
    });
    return { ok: false, message: errorMessage(err) };
  }
}

async function appendSteeringMessage(
  repository: AsyncTaskRepository,
  initialTask: AsyncTaskRecord,
  entry: Record<string, unknown>,
): Promise<AsyncTaskRecord | null> {
  let task = initialTask;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const updated = await repository.transitionTask({
      taskId: task.id,
      leaseToken: task.leaseToken,
      fencingVersion: task.fencingVersion,
      status: task.status,
      now: nowIso(),
      expectedUpdatedAt: task.updatedAt,
      expectedPrivateCorrelationJson: task.privateCorrelationJson,
      privateCorrelationJson: {
        ...task.privateCorrelationJson,
        steering: [...steeringMessages(task.privateCorrelationJson), entry],
      },
    });
    if (updated) return updated;
    const latest = await repository.getTask(task.id);
    if (!latest || isAsyncTaskTerminal(latest.status)) return null;
    task = latest;
  }
  throw new Error('Could not persist steering message; retry task_message.');
}

export async function executeDelegatedAgentTask(input: {
  task: AsyncTaskRecord;
  taskInput: StartDelegatedAgentTaskInput;
  controller: AbortController;
  repository: AsyncTaskRepository;
  active: Map<string, AbortController>;
  cancelLinkedChildTasks: (parent: AsyncTaskRecord) => Promise<number>;
  waitForTaskChange?: (
    parent: AsyncTaskRecord,
    options: { signal: AbortSignal; timeoutMs: number },
  ) => Promise<void>;
}): Promise<void> {
  const {
    task,
    taskInput,
    controller,
    repository,
    active,
    cancelLinkedChildTasks,
    waitForTaskChange,
  } = input;
  const startedAt = nowIso();
  const running = await repository.transitionTask({
    taskId: task.id,
    leaseToken: task.leaseToken,
    fencingVersion: task.fencingVersion,
    status: 'running',
    now: startedAt,
    startedAt,
    heartbeatAt: startedAt,
    privateCorrelationJson: {
      ...task.privateCorrelationJson,
      progress: {
        phase: 'running',
        childRunnerActive: true,
        lastProgress: 'Delegated task started.',
      },
    },
  });
  if (!running) {
    active.delete(task.id);
    return;
  }
  const heartbeat = setInterval(() => {
    void repository.transitionTask({
      taskId: task.id,
      leaseToken: task.leaseToken,
      fencingVersion: task.fencingVersion,
      status: 'running',
      now: nowIso(),
      heartbeatAt: nowIso(),
    });
  }, ASYNC_TASK_HEARTBEAT_MS);
  heartbeat.unref?.();
  try {
    const result = await taskInput.run({
      task,
      prompt: delegatedPrompt(taskInput),
      ...(taskInput.targetAgentId
        ? { targetAgentId: taskInput.targetAgentId }
        : {}),
      signal: controller.signal,
      onProcessStarted: async (handle) => {
        const updated = await transitionPrivateCorrelation(repository, task, {
          status: 'running',
          heartbeatAt: nowIso(),
          update: (privateCorrelationJson) => ({
            ...privateCorrelationJson,
            process: handle,
            progress: {
              phase: 'running',
              childRunnerActive: true,
              lastProgress: 'Delegated agent process started.',
            },
          }),
        });
        if (!updated) {
          throw new Error('Failed to persist delegated agent process handle.');
        }
      },
      onProgress: async (summary) => {
        await transitionPrivateCorrelation(repository, task, {
          heartbeatAt: nowIso(),
          update: (privateCorrelationJson) => ({
            ...privateCorrelationJson,
            progress: {
              phase: 'running',
              childRunnerActive: true,
              lastProgress: truncate(summary),
              lastToolSummary: 'delegated_agent',
            },
          }),
        });
      },
    });
    if (result.failure) {
      throw Object.assign(
        new Error(result.errorSummary ?? 'Delegated agent run failed.'),
        { failure: result.failure },
      );
    }
    await transitionPrivateCorrelation(repository, task, {
      update: (privateCorrelationJson) => ({
        ...privateCorrelationJson,
        progress: {
          ...(isRecordValue(privateCorrelationJson.progress)
            ? privateCorrelationJson.progress
            : {}),
          phase: 'waiting_subtasks',
          childRunnerActive: false,
          lastProgress: 'Delegated agent finished; waiting for child tasks.',
        },
      }),
    });
    const childResult = await waitForLinkedChildTasks(repository, task, {
      signal: controller.signal,
      waitForTaskChange,
    });
    if (childResult.hasFailure) {
      throw new DelegatedChildFailureError(
        childResult.summary,
        {
          type: 'child_task',
          attemptedAction: task.summary ?? 'Complete delegated task.',
          partialResult: result.outputSummary ?? null,
        },
        childResult.terminalChildren,
      );
    }
    await finishDelegatedAgentTask(repository, task, {
      status: 'completed',
      output: result.outputSummary ?? 'delegated task completed',
      error: result.errorSummary ?? '',
      subtasks: childResult.summary,
      needsAttention: 'none',
      terminalChildren: childResult.terminalChildren,
    });
  } catch (err) {
    const aborted = controller.signal.aborted;
    const timedOut = isTimeoutError(err);
    const cancelledChildren =
      err instanceof DelegatedChildFailureError
        ? 0
        : await cancelLinkedChildTasks(task);
    await finishDelegatedAgentTask(repository, task, {
      status: aborted ? 'cancelled' : timedOut ? 'timed_out' : 'failed',
      output: aborted ? 'cancelled' : timedOut ? 'timed out' : 'failed',
      error: errorMessage(err),
      subtasks:
        err instanceof DelegatedChildFailureError
          ? err.subtasks
          : cancelledChildren > 0
            ? `0 completed, 0 failed, ${cancelledChildren} cancelled`
            : aborted
              ? '0 completed, 0 failed, 1 cancelled'
              : '0 completed, 1 failed, 0 cancelled',
      needsAttention: aborted ? 'none' : errorMessage(err),
      failure:
        err instanceof DelegatedChildFailureError
          ? err.failure
          : failureMetadata(err, task, { aborted, timedOut }),
      terminalChildren:
        err instanceof DelegatedChildFailureError
          ? err.terminalChildren
          : undefined,
    });
  } finally {
    clearInterval(heartbeat);
    active.delete(task.id);
  }
}

async function finishDelegatedAgentTask(
  repository: AsyncTaskRepository,
  task: AsyncTaskRecord,
  input: {
    status: 'completed' | 'cancelled' | 'timed_out' | 'failed';
    output: string;
    error: string;
    subtasks: string;
    needsAttention: string;
    failure?: AgentFailureMetadata;
    terminalChildren?: ReturnType<typeof toPublicAsyncTaskDto>[];
  },
) {
  const now = nowIso();
  const latest = await repository.getTask(task.id);
  const updated = await repository.transitionTask({
    taskId: task.id,
    leaseToken: task.leaseToken,
    fencingVersion: task.fencingVersion,
    status: input.status,
    now,
    terminalAt: now,
    privateCorrelationJson: {
      ...(latest?.privateCorrelationJson ?? task.privateCorrelationJson),
      ...(input.failure ? { failure: input.failure } : {}),
      ...(input.terminalChildren
        ? { terminalChildren: input.terminalChildren }
        : {}),
    },
    outputSummary: truncate(input.output),
    errorSummary: truncate(input.error),
    receiptJson: {
      completed: truncate(input.output),
      used: 'Gantry agent run',
      changed: 'none',
      delegated: 'yes',
      subtasks: input.subtasks,
      needsAttention: input.needsAttention,
    },
  });
  if (updated) notifyAsyncTaskChange(repository);
}
async function waitForLinkedChildTasks(
  repository: AsyncTaskRepository,
  parent: AsyncTaskRecord,
  input: {
    signal: AbortSignal;
    waitForTaskChange?: (
      parent: AsyncTaskRecord,
      options: { signal: AbortSignal; timeoutMs: number },
    ) => Promise<void>;
  },
): Promise<{
  summary: string;
  hasFailure: boolean;
  terminalChildren: ReturnType<typeof toPublicAsyncTaskDto>[];
}> {
  while (!input.signal.aborted) {
    const counts = await linkedChildTaskCounts(repository, parent);
    if (activeChildCount(counts) === 0) {
      const terminalChildren = await linkedTerminalChildTasks(
        repository,
        parent,
      );
      return childTaskResult(counts, terminalChildren);
    }
    await waitForChildTaskWakeup(parent, input);
  }
  throw new Error('cancelled');
}
async function linkedTerminalChildTasks(
  repository: AsyncTaskRepository,
  parent: AsyncTaskRecord,
): Promise<ReturnType<typeof toPublicAsyncTaskDto>[]> {
  const failures = await repository.listTasks({
    appId: parent.appId,
    parentTaskId: parent.id,
    statuses: ['failed', 'timed_out', 'cancelled'],
    limit: 100,
    order: 'oldest_first',
  });
  const completed = await repository.listTasks({
    appId: parent.appId,
    parentTaskId: parent.id,
    statuses: ['completed'],
    limit: Math.max(1, 100 - failures.length),
    order: 'oldest_first',
  });
  return [...failures, ...completed].slice(0, 100).map(toPublicAsyncTaskDto);
}
async function waitForChildTaskWakeup(
  parent: AsyncTaskRecord,
  input: {
    signal: AbortSignal;
    waitForTaskChange?: (
      parent: AsyncTaskRecord,
      options: { signal: AbortSignal; timeoutMs: number },
    ) => Promise<void>;
  },
): Promise<void> {
  if (input.waitForTaskChange) {
    await input.waitForTaskChange(parent, {
      signal: input.signal,
      timeoutMs: ASYNC_TASK_WAKE_FALLBACK_MS,
    });
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ASYNC_TASK_WAKE_FALLBACK_MS);
    input.signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
async function linkedChildTaskCounts(
  repository: AsyncTaskRepository,
  parent: AsyncTaskRecord,
): Promise<AsyncTaskStatusCount[]> {
  return repository.countTasksByStatus({
    appId: parent.appId,
    parentTaskId: parent.id,
  });
}
function activeChildCount(counts: AsyncTaskStatusCount[]): number {
  return counts.reduce(
    (total, entry) =>
      ['queued', 'running', 'needs_attention'].includes(entry.status)
        ? total + entry.count
        : total,
    0,
  );
}
function statusCount(
  counts: AsyncTaskStatusCount[],
  status: AsyncTaskRecord['status'],
): number {
  return counts.find((entry) => entry.status === status)?.count ?? 0;
}
function childTaskResult(
  counts: AsyncTaskStatusCount[],
  terminalChildren: ReturnType<typeof toPublicAsyncTaskDto>[],
): {
  summary: string;
  hasFailure: boolean;
  terminalChildren: ReturnType<typeof toPublicAsyncTaskDto>[];
} {
  const completed = 1 + statusCount(counts, 'completed');
  const failed =
    statusCount(counts, 'failed') + statusCount(counts, 'timed_out');
  const cancelled = statusCount(counts, 'cancelled');
  return {
    summary: `${completed} completed, ${failed} failed, ${cancelled} cancelled`,
    hasFailure: failed > 0 || cancelled > 0,
    terminalChildren,
  };
}
function failureMetadata(
  error: unknown,
  task: AsyncTaskRecord,
  state: { aborted: boolean; timedOut: boolean },
): AgentFailureMetadata {
  const preserved = isRecordValue(error) ? error.failure : undefined;
  if (isRecordValue(preserved)) {
    return preserved as unknown as AgentFailureMetadata;
  }
  return {
    type: state.aborted
      ? 'cancelled'
      : state.timedOut
        ? 'timeout'
        : 'execution',
    attemptedAction: task.summary ?? 'Complete delegated task.',
  };
}
function isRecordValue(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

async function transitionPrivateCorrelation(
  repository: AsyncTaskRepository,
  initialTask: AsyncTaskRecord,
  input: {
    status?: AsyncTaskRecord['status'];
    heartbeatAt?: string;
    update: (
      privateCorrelationJson: Record<string, unknown>,
    ) => Record<string, unknown>;
  },
): Promise<AsyncTaskRecord | null> {
  let task = (await repository.getTask(initialTask.id)) ?? initialTask;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (isAsyncTaskTerminal(task.status)) return null;
    const updated = await repository.transitionTask({
      taskId: task.id,
      leaseToken: task.leaseToken,
      fencingVersion: task.fencingVersion,
      status: input.status ?? task.status,
      now: nowIso(),
      heartbeatAt: input.heartbeatAt,
      expectedUpdatedAt: task.updatedAt,
      expectedPrivateCorrelationJson: task.privateCorrelationJson,
      privateCorrelationJson: input.update(task.privateCorrelationJson),
    });
    if (updated) return updated;
    const latest = await repository.getTask(task.id);
    if (!latest) return null;
    task = latest;
  }
  throw new Error('Could not persist delegated task progress.');
}

async function updateSteering(
  repository: AsyncTaskRepository,
  task: AsyncTaskRecord,
  steeringId: string,
  patch: Record<string, unknown>,
) {
  let latest = task;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const updated = await repository.transitionTask({
      taskId: latest.id,
      leaseToken: latest.leaseToken,
      fencingVersion: latest.fencingVersion,
      status: latest.status,
      now: nowIso(),
      expectedUpdatedAt: latest.updatedAt,
      expectedPrivateCorrelationJson: latest.privateCorrelationJson,
      privateCorrelationJson: {
        ...latest.privateCorrelationJson,
        steering: steeringMessages(latest.privateCorrelationJson).map(
          (entry) => (entry.id === steeringId ? { ...entry, ...patch } : entry),
        ),
      },
    });
    if (updated) return;
    const reloaded = await repository.getTask(latest.id);
    if (!reloaded || isAsyncTaskTerminal(reloaded.status)) return;
    latest = reloaded;
  }
  throw new Error('Could not update steering message; retry task_message.');
}

function delegatedPrompt(input: StartDelegatedAgentTaskInput): string {
  return [
    'You are running as a delegated async Gantry subagent.',
    'Complete the objective and return a concise receipt.',
    `Objective: ${input.objective.trim()}`,
    input.context?.trim() ? `Context: ${input.context.trim()}` : '',
    input.expectedOutput?.trim()
      ? `Expected output: ${input.expectedOutput.trim()}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function steeringMessages(
  value: Record<string, unknown>,
): Array<Record<string, unknown>> {
  return Array.isArray(value.steering)
    ? value.steering.filter((entry): entry is Record<string, unknown> =>
        Boolean(entry && typeof entry === 'object' && !Array.isArray(entry)),
      )
    : [];
}
