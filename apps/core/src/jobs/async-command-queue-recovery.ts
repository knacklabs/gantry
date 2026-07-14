import type {
  AsyncTaskRecord,
  AsyncTaskRepository,
} from '../domain/ports/async-tasks.js';
import type { AsyncCommandLaunchControl } from './async-command-task-service.js';
import type { PendingAsyncTaskExecution } from './async-command-task-queue-types.js';
import { failedReceipt } from './async-command-task-receipts.js';
import { readEncryptedAsyncTaskPayload } from './async-task-execution-payload.js';
import { notifyAsyncTaskChange } from './async-task-change-waiter.js';
import type { StartDelegatedAgentTaskInput } from './async-delegated-agent-task.js';
import { nowIso } from '../shared/time/datetime.js';

type DurableAsyncCommandPayload = {
  command: string;
  input: PendingAsyncTaskExecution['input'];
  launchControl: AsyncCommandLaunchControl;
};

type DurableDelegatedAgentPayload = Pick<
  StartDelegatedAgentTaskInput,
  | 'context'
  | 'expectedOutput'
  | 'objective'
  | 'providerAccountId'
  | 'targetAgentId'
  | 'workspaceFolder'
>;

export async function recoverQueuedAsyncTasks(input: {
  repository: AsyncTaskRepository;
  pending: Map<string, PendingAsyncTaskExecution>;
  appId: string;
  agentId?: string;
  createDelegatedRun?: (
    task: AsyncTaskRecord,
    taskInput: Omit<StartDelegatedAgentTaskInput, 'run'>,
  ) => StartDelegatedAgentTaskInput['run'];
  cancelLinkedChildTasks: (parent: AsyncTaskRecord) => Promise<number>;
  waitForTaskChange?: (
    parent: AsyncTaskRecord,
    options: { signal: AbortSignal; timeoutMs: number },
  ) => Promise<void>;
  limit?: number;
}): Promise<number> {
  let recovered = await recoverQueuedAsyncCommandTasks(input);
  if (input.createDelegatedRun) {
    recovered += await recoverQueuedDelegatedAgentTasks({
      ...input,
      createRun: input.createDelegatedRun,
    });
  }
  return recovered;
}

async function recoverQueuedAsyncCommandTasks(input: {
  repository: AsyncTaskRepository;
  pending: Map<string, PendingAsyncTaskExecution>;
  appId: string;
  agentId?: string;
  limit?: number;
}): Promise<number> {
  const tasks = await input.repository.listTasks({
    appId: input.appId,
    agentId: input.agentId,
    kind: 'async_command',
    statuses: ['queued'],
    order: 'oldest_first',
    limit: input.limit ?? 100,
  });
  let recovered = 0;
  for (const task of tasks) {
    if (input.pending.has(task.id)) continue;
    const payload =
      readEncryptedAsyncTaskPayload<DurableAsyncCommandPayload>(task);
    if (!isDurableAsyncCommandPayload(payload)) {
      if (await failUnrecoverableQueuedTask(input.repository, task)) {
        recovered += 1;
      }
      continue;
    }
    input.pending.set(task.id, {
      task,
      command: payload.command,
      input: payload.input,
      controller: new AbortController(),
      launchControl: payload.launchControl,
    });
    recovered += 1;
  }
  return recovered;
}

async function recoverQueuedDelegatedAgentTasks(input: {
  repository: AsyncTaskRepository;
  pending: Map<string, PendingAsyncTaskExecution>;
  appId: string;
  agentId?: string;
  createRun: (
    task: AsyncTaskRecord,
    taskInput: Omit<StartDelegatedAgentTaskInput, 'run'>,
  ) => StartDelegatedAgentTaskInput['run'];
  cancelLinkedChildTasks: (parent: AsyncTaskRecord) => Promise<number>;
  waitForTaskChange?: (
    parent: AsyncTaskRecord,
    options: { signal: AbortSignal; timeoutMs: number },
  ) => Promise<void>;
  limit?: number;
}): Promise<number> {
  const tasks = await input.repository.listTasks({
    appId: input.appId,
    agentId: input.agentId,
    kind: 'delegated_agent',
    statuses: ['queued'],
    order: 'oldest_first',
    limit: input.limit ?? 100,
  });
  let recovered = 0;
  for (const task of tasks) {
    if (input.pending.has(task.id)) continue;
    const payload =
      readEncryptedAsyncTaskPayload<DurableDelegatedAgentPayload>(task);
    if (!isDurableDelegatedAgentPayload(payload)) {
      if (await failUnrecoverableQueuedTask(input.repository, task)) {
        recovered += 1;
      }
      continue;
    }
    const taskInput = {
      appId: task.appId,
      agentId: task.agentId,
      conversationId: task.conversationId ?? '',
      threadId: task.threadId,
      parentRunId: task.parentRunId,
      objective: payload.objective,
      context: payload.context,
      expectedOutput: payload.expectedOutput,
      providerAccountId: payload.providerAccountId,
      targetAgentId: payload.targetAgentId,
      workspaceFolder: payload.workspaceFolder,
    };
    input.pending.set(task.id, {
      task,
      command: '',
      input: undefined as never,
      controller: new AbortController(),
      launchControl: undefined as never,
      delegated: {
        taskInput: {
          ...taskInput,
          run: input.createRun(task, taskInput),
        },
        cancelLinkedChildTasks: input.cancelLinkedChildTasks,
        waitForTaskChange: input.waitForTaskChange,
      },
    });
    recovered += 1;
  }
  return recovered;
}

async function failUnrecoverableQueuedTask(
  repository: AsyncTaskRepository,
  task: AsyncTaskRecord,
): Promise<boolean> {
  const now = nowIso();
  const updated = await repository.transitionTask({
    taskId: task.id,
    leaseToken: task.leaseToken,
    fencingVersion: task.fencingVersion,
    status: 'failed',
    now,
    terminalAt: now,
    errorSummary: 'Queued async task has no recoverable execution payload.',
    receiptJson: failedReceipt(
      task,
      'failed before recovery because execution payload is missing or unreadable',
    ),
  });
  if (updated) notifyAsyncTaskChange(repository);
  return Boolean(updated);
}

function isDurableAsyncCommandPayload(
  value: DurableAsyncCommandPayload | null,
): value is DurableAsyncCommandPayload {
  return Boolean(
    value &&
    typeof value.command === 'string' &&
    value.launchControl &&
    typeof value.launchControl === 'object',
  );
}

function isDurableDelegatedAgentPayload(
  value: DurableDelegatedAgentPayload | null,
): value is DurableDelegatedAgentPayload {
  return Boolean(
    value &&
    typeof value.objective === 'string' &&
    (value.providerAccountId === undefined ||
      value.providerAccountId === null ||
      typeof value.providerAccountId === 'string') &&
    (value.targetAgentId === undefined ||
      typeof value.targetAgentId === 'string') &&
    typeof value.workspaceFolder === 'string',
  );
}
