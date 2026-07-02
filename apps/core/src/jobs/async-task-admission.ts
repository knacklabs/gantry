import type {
  AsyncTaskCreateInput,
  AsyncTaskRecord,
  AsyncTaskRepository,
  AsyncTaskStatus,
} from '../domain/ports/async-tasks.js';

const BACKLOG_STATUSES: AsyncTaskStatus[] = [
  'queued',
  'running',
  'needs_attention',
];

const MAX_BACKLOG_PER_APP = 64;
const MAX_BACKLOG_PER_AGENT = 32;

export async function createAdmittedAsyncTask(input: {
  repository: AsyncTaskRepository;
  task: AsyncTaskCreateInput;
}): Promise<
  { ok: true; task: AsyncTaskRecord } | { ok: false; message: string }
> {
  const task = input.repository.createTaskWithBacklogAdmission
    ? await input.repository.createTaskWithBacklogAdmission({
        task: input.task,
        maxBacklogPerApp: MAX_BACKLOG_PER_APP,
        maxBacklogPerAgent: MAX_BACKLOG_PER_AGENT,
        statuses: BACKLOG_STATUSES,
      })
    : await createTaskWithLocalAdmission(input.repository, input.task);
  return task ? { ok: true, task } : backlogFull();
}

async function createTaskWithLocalAdmission(
  repository: AsyncTaskRepository,
  task: AsyncTaskCreateInput,
): Promise<AsyncTaskRecord | null> {
  const [appCount, agentCount] = await Promise.all([
    countBacklog(repository, { appId: task.appId, kind: task.kind }),
    countBacklog(repository, {
      appId: task.appId,
      agentId: task.agentId,
      kind: task.kind,
    }),
  ]);
  if (appCount >= MAX_BACKLOG_PER_APP || agentCount >= MAX_BACKLOG_PER_AGENT) {
    return null;
  }
  return repository.createTask(task);
}

async function countBacklog(
  repository: AsyncTaskRepository,
  filter: Parameters<AsyncTaskRepository['countTasksByStatus']>[0],
): Promise<number> {
  const counts = await repository.countTasksByStatus({
    ...filter,
    statuses: BACKLOG_STATUSES,
  });
  return counts.reduce((sum, entry) => sum + entry.count, 0);
}

function backlogFull(): { ok: false; message: string } {
  return {
    ok: false,
    message:
      'Async task backlog is full for this agent. Wait for existing tasks to finish or cancel stale tasks before starting more.',
  };
}
