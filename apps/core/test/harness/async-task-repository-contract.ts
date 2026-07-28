import { expect } from 'vitest';

import type {
  AsyncTaskBacklogAdmissionInput,
  AsyncTaskRecord,
  AsyncTaskRepository,
  AsyncTaskStatus,
} from '@core/domain/ports/async-tasks.js';

const BACKLOG_STATUSES: AsyncTaskStatus[] = [
  'queued',
  'running',
  'needs_attention',
];
const MAX_BACKLOG_PER_AGENT = 3;

export interface AsyncTaskRepositoryContractOptions {
  repository: AsyncTaskRepository;
  idPrefix?: string;
  appId?: string;
  agentId?: string;
  conversationId?: string;
  now?: string;
}

export interface AsyncTaskRepositoryContractEvidence {
  admissions: Array<AsyncTaskRecord | null>;
  backlog: AsyncTaskRecord[];
  claims: Array<AsyncTaskRecord | null>;
  claimTaskId: string;
}

export async function exerciseAsyncTaskRepositoryContract(
  options: AsyncTaskRepositoryContractOptions,
): Promise<AsyncTaskRepositoryContractEvidence> {
  const {
    repository,
    idPrefix = 'async-task-repository-contract',
    appId = 'app-1',
    agentId = 'agent-1',
    conversationId = 'conversation-1',
    now = '2026-07-28T00:00:00.000Z',
  } = options;

  const taskInput = (
    suffix: string,
  ): AsyncTaskBacklogAdmissionInput['task'] => ({
    id: `${idPrefix}-${suffix}`,
    appId,
    agentId,
    conversationId,
    kind: 'async_command',
    status: 'queued',
    admissionClass: 'task',
    authoritySnapshotJson: {},
    leaseToken: `${idPrefix}-${suffix}-lease`,
    fencingVersion: 1,
    now,
  });

  const claimTaskId = `${idPrefix}-seed-1`;
  await repository.createTask(taskInput('seed-1'));
  await repository.createTask(taskInput('seed-2'));

  const admit = (suffix: string) =>
    repository.createTaskWithBacklogAdmission({
      task: taskInput(suffix),
      maxBacklogPerApp: MAX_BACKLOG_PER_AGENT + 1,
      maxBacklogPerAgent: MAX_BACKLOG_PER_AGENT,
      statuses: BACKLOG_STATUSES,
    });
  const admissions = await Promise.all([
    admit('concurrent-1'),
    admit('concurrent-2'),
  ]);

  const backlog = await repository.listTasks({
    appId,
    agentId,
    kind: 'async_command',
    statuses: BACKLOG_STATUSES,
    limit: 100,
  });

  const claims = await Promise.all([
    repository.claimQueuedTask({
      taskId: claimTaskId,
      leaseToken: `${idPrefix}-claim-1`,
      now,
      maxRunningPerApp: 4,
      maxRunningPerAgent: 4,
    }),
    repository.claimQueuedTask({
      taskId: claimTaskId,
      leaseToken: `${idPrefix}-claim-2`,
      now,
      maxRunningPerApp: 4,
      maxRunningPerAgent: 4,
    }),
  ]);

  return { admissions, backlog, claims, claimTaskId };
}

export async function expectAsyncTaskRepositoryContract(
  options: AsyncTaskRepositoryContractOptions,
): Promise<void> {
  const evidence = await exerciseAsyncTaskRepositoryContract(options);
  const admitted = evidence.admissions.filter(
    (task): task is AsyncTaskRecord => task !== null,
  );
  const claimed = evidence.claims.filter(
    (task): task is AsyncTaskRecord => task !== null,
  );

  expect(admitted).toHaveLength(1);
  expect(evidence.backlog).toHaveLength(MAX_BACKLOG_PER_AGENT);
  expect(claimed).toHaveLength(1);
  expect(claimed[0]).toMatchObject({
    id: evidence.claimTaskId,
    status: 'running',
  });
}
