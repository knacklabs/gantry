import type {
  AsyncTaskKind,
  AsyncTaskRepository,
} from '../domain/ports/async-tasks.js';
import { nowIso } from '../shared/time/datetime.js';
import { failedReceipt } from './async-command-task-receipts.js';
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

export async function failUnrecoverableQueuedAsyncTasks(input: {
  repository: AsyncTaskRepository;
  appId: string;
  agentId?: string;
  limit?: number;
}): Promise<number> {
  let failed = 0;
  for (const kind of ['mcp_tool_call', 'delegated_agent'] as AsyncTaskKind[]) {
    const tasks = await input.repository.listTasks({
      appId: input.appId,
      agentId: input.agentId,
      kind,
      statuses: ['queued'],
      limit: input.limit ?? 100,
    });
    for (const task of tasks) {
      const now = nowIso();
      const updated = await input.repository.transitionTask({
        taskId: task.id,
        leaseToken: task.leaseToken,
        fencingVersion: task.fencingVersion,
        status: 'failed',
        now,
        terminalAt: now,
        errorSummary:
          'Task worker restarted before this queued task could be claimed.',
        receiptJson: failedReceipt(
          task,
          'failed before queued task claim after worker restart',
        ),
      });
      if (updated) failed += 1;
    }
  }
  return failed;
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