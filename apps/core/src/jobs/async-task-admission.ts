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
  const task = await input.repository.createTaskWithBacklogAdmission({
    task: input.task,
    maxBacklogPerApp: MAX_BACKLOG_PER_APP,
    maxBacklogPerAgent: MAX_BACKLOG_PER_AGENT,
    statuses: BACKLOG_STATUSES,
  });
  return task ? { ok: true, task } : backlogFull();
}

function backlogFull(): { ok: false; message: string } {
  return {
    ok: false,
    message:
      'Async task backlog is full for this agent. Wait for existing tasks to finish or cancel stale tasks before starting more.',
  };
}
