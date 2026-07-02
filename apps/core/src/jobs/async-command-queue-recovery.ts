import type { AsyncTaskRepository } from '../domain/ports/async-tasks.js';
import type { AsyncCommandLaunchControl } from './async-command-task-service.js';
import type { PendingAsyncTaskExecution } from './async-command-task-queue-types.js';
import { readEncryptedAsyncTaskPayload } from './async-task-execution-payload.js';

type DurableAsyncCommandPayload = {
  command: string;
  input: PendingAsyncTaskExecution['input'];
  launchControl: AsyncCommandLaunchControl;
};

export async function recoverQueuedAsyncCommandTasks(input: {
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
    limit: input.limit ?? 100,
  });
  let recovered = 0;
  for (const task of tasks) {
    if (input.pending.has(task.id)) continue;
    const payload =
      readEncryptedAsyncTaskPayload<DurableAsyncCommandPayload>(task);
    if (!isDurableAsyncCommandPayload(payload)) continue;
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
