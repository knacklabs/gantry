import {
  type AgentFailureMetadata,
  type AsyncTaskRecord,
  type AsyncTaskRepository,
  type AsyncTaskStatus,
  isAsyncTaskTerminal,
} from '../domain/ports/async-tasks.js';
import { deliverPendingCallableAgentFollowUp } from './async-delegated-agent-follow-up.js';
import type { AsyncCommandTaskServiceOptions } from './async-command-task-queue-types.js';
import type { AsyncCommandRunnerResult } from './async-command-task-types.js';
import { drainQueuedAsyncTasks } from './async-command-task-drainer.js';

export function drainQueuedCommandTasks(
  input: Omit<Parameters<typeof drainQueuedAsyncTasks>[0], 'limits'>,
): Promise<void> {
  return drainQueuedAsyncTasks({
    ...input,
    limits: { perApp: 4, perAgent: 2 },
  });
}

export function delegatedAgentFailureResult(
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

export function isAgentFacingTask(task: AsyncTaskRecord): boolean {
  return task.kind !== 'session_compaction';
}

export function delegatedCompletion(task: AsyncTaskRecord): {
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

export async function recoverPendingDelegatedAgentFollowUps(input: {
  repository: AsyncTaskRepository;
  completionMessageRepository: NonNullable<
    AsyncCommandTaskServiceOptions['completionMessageRepository']
  >;
  appId: string;
  agentId?: string;
  limit?: number;
}): Promise<number> {
  const tasks = await input.repository.listTasks({
    appId: input.appId,
    agentId: input.agentId,
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
        repository: input.repository,
        messageRepository: input.completionMessageRepository,
      }).catch(() => false)
    ) {
      delivered += 1;
    }
  }
  return delivered;
}

export type RecoverPendingDelegatedAgentFollowUpsInput = Pick<
  Parameters<typeof recoverPendingDelegatedAgentFollowUps>[0],
  'appId' | 'agentId' | 'limit'
>;
