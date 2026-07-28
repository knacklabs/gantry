import { expect } from 'vitest';

import type {
  AsyncTaskBacklogAdmissionInput,
  AsyncTaskKind,
  AsyncTaskRecord,
  AsyncTaskRepository,
  AsyncTaskScopedAdmissionResult,
  AsyncTaskStatus,
} from '@core/domain/ports/async-tasks.js';

const BACKLOG_STATUSES: AsyncTaskStatus[] = [
  'queued',
  'running',
  'needs_attention',
];
const DEFAULT_MAX_BACKLOG_PER_AGENT = 3;
const DEFAULT_MAX_BACKLOG_PER_APP = 3;
const DEFAULT_MAX_RUNNING_PER_AGENT = 2;
const DEFAULT_MAX_RUNNING_PER_APP = 3;
const CONCURRENT_ATTEMPTS = 2;

export interface AsyncTaskRepositoryContractOptions {
  repository: AsyncTaskRepository;
  idPrefix?: string;
  appId?: string;
  agentId?: string;
  additionalAgentIds?: string[];
  conversationId?: string;
  now?: string;
  maxBacklogPerAgent?: number;
  maxBacklogPerApp?: number;
  maxRunningPerAgent?: number;
  maxRunningPerApp?: number;
}

export interface AsyncTaskRepositoryContractEvidence {
  admissions: Array<AsyncTaskRecord | null>;
  backlog: AsyncTaskRecord[];
  appAdmissions: Array<AsyncTaskRecord | null>;
  appBacklog: AsyncTaskRecord[];
  scopedAdmissions: AsyncTaskScopedAdmissionResult[];
  scopedActiveTasks: AsyncTaskRecord[];
  claims: Array<AsyncTaskRecord | null>;
  claimTaskId: string;
  agentCapacityClaims: Array<AsyncTaskRecord | null>;
  agentRunningTasks: AsyncTaskRecord[];
  appCapacityClaims: Array<AsyncTaskRecord | null>;
  appRunningTasks: AsyncTaskRecord[];
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
    maxBacklogPerAgent = DEFAULT_MAX_BACKLOG_PER_AGENT,
    maxBacklogPerApp = DEFAULT_MAX_BACKLOG_PER_APP,
    maxRunningPerAgent = DEFAULT_MAX_RUNNING_PER_AGENT,
    maxRunningPerApp = DEFAULT_MAX_RUNNING_PER_APP,
  } = options;
  const requiredAdditionalAgentIds = Math.max(
    maxBacklogPerApp,
    maxRunningPerApp,
  );
  const additionalAgentIds =
    options.additionalAgentIds ??
    Array.from(
      { length: requiredAdditionalAgentIds },
      (_, index) => `${agentId}-contract-${index + 1}`,
    );
  if (additionalAgentIds.length < requiredAdditionalAgentIds) {
    throw new Error(
      `Async task repository contract requires ${requiredAdditionalAgentIds} additional agent ids.`,
    );
  }
  if (
    maxBacklogPerAgent < 2 ||
    maxBacklogPerApp < 2 ||
    maxRunningPerAgent < 2 ||
    maxRunningPerApp <= maxRunningPerAgent
  ) {
    throw new Error(
      'Async task repository contract caps must leave one seeded slot and keep app running capacity above agent running capacity.',
    );
  }
  const appScopedAgentIds = [agentId, ...additionalAgentIds];

  const taskInput = (
    suffix: string,
    {
      taskAgentId = agentId,
      taskConversationId = conversationId,
      threadId = null,
      kind = 'async_command',
      status = 'queued',
    }: {
      taskAgentId?: string;
      taskConversationId?: string;
      threadId?: string | null;
      kind?: AsyncTaskKind;
      status?: AsyncTaskStatus;
    } = {},
  ): AsyncTaskBacklogAdmissionInput['task'] => ({
    id: `${idPrefix}-${suffix}`,
    appId,
    agentId: taskAgentId,
    conversationId: taskConversationId,
    threadId,
    kind,
    status,
    admissionClass: 'task',
    authoritySnapshotJson: {},
    leaseToken: `${idPrefix}-${suffix}-lease`,
    fencingVersion: 1,
    now,
  });

  await Promise.all(
    Array.from({ length: maxBacklogPerAgent - 1 }, (_, index) =>
      repository.createTask(taskInput(`agent-backlog-seed-${index + 1}`)),
    ),
  );

  const admit = (suffix: string) =>
    repository.createTaskWithBacklogAdmission({
      task: taskInput(suffix),
      maxBacklogPerApp: maxBacklogPerAgent + CONCURRENT_ATTEMPTS - 1,
      maxBacklogPerAgent,
      statuses: BACKLOG_STATUSES,
    });
  const admissions = await Promise.all([
    admit('agent-backlog-concurrent-1'),
    admit('agent-backlog-concurrent-2'),
  ]);

  const backlog = await repository.listTasks({
    appId,
    agentId,
    kind: 'async_command',
    statuses: BACKLOG_STATUSES,
    limit: 100,
  });

  await Promise.all(
    Array.from({ length: maxBacklogPerApp - 1 }, (_, index) =>
      repository.createTask(
        taskInput(`app-backlog-seed-${index + 1}`, {
          taskAgentId: appScopedAgentIds[index],
          kind: 'delegated_agent',
        }),
      ),
    ),
  );
  const appAdmissionAgents = appScopedAgentIds.slice(
    maxBacklogPerApp - 1,
    maxBacklogPerApp + 1,
  );
  const appAdmissions = await Promise.all(
    appAdmissionAgents.map((taskAgentId, index) =>
      repository.createTaskWithBacklogAdmission({
        task: taskInput(`app-backlog-concurrent-${index + 1}`, {
          taskAgentId,
          kind: 'delegated_agent',
        }),
        maxBacklogPerApp,
        maxBacklogPerAgent: maxBacklogPerApp,
        statuses: BACKLOG_STATUSES,
      }),
    ),
  );
  const appBacklog = await repository.listTasks({
    appId,
    kind: 'delegated_agent',
    statuses: BACKLOG_STATUSES,
    limit: 100,
  });

  const scopedConversationId = `${conversationId}-scoped`;
  const scopedAdmissions = await Promise.all(
    Array.from({ length: CONCURRENT_ATTEMPTS }, (_, index) =>
      repository.createTaskWithScopedAdmission({
        task: taskInput(`scoped-concurrent-${index + 1}`, {
          taskConversationId: scopedConversationId,
          threadId: 'thread-1',
          kind: 'session_compaction',
        }),
        activeStatuses: ['queued', 'running'],
      }),
    ),
  );
  const scopedActiveTasks = await repository.listTasks({
    appId,
    agentId,
    kind: 'session_compaction',
    conversationId: scopedConversationId,
    threadId: 'thread-1',
    statuses: ['queued', 'running'],
    limit: 100,
  });

  const claimTaskId = `${idPrefix}-claim-once`;
  await repository.createTask(
    taskInput('claim-once', { kind: 'mcp_tool_call' }),
  );
  const claims = await Promise.all([
    repository.claimQueuedTask({
      taskId: claimTaskId,
      leaseToken: `${idPrefix}-claim-1`,
      now,
      maxRunningPerApp,
      maxRunningPerAgent,
    }),
    repository.claimQueuedTask({
      taskId: claimTaskId,
      leaseToken: `${idPrefix}-claim-2`,
      now,
      maxRunningPerApp,
      maxRunningPerAgent,
    }),
  ]);

  await Promise.all(
    Array.from({ length: maxRunningPerAgent - 2 }, (_, index) =>
      repository.createTask(
        taskInput(`agent-running-seed-${index + 1}`, {
          kind: 'mcp_tool_call',
          status: 'running',
        }),
      ),
    ),
  );
  const agentClaimTaskIds = Array.from(
    { length: CONCURRENT_ATTEMPTS },
    (_, index) => `${idPrefix}-agent-capacity-queued-${index + 1}`,
  );
  await Promise.all(
    agentClaimTaskIds.map((taskId, index) =>
      repository.createTask(
        taskInput(`agent-capacity-queued-${index + 1}`, {
          kind: 'mcp_tool_call',
        }),
      ),
    ),
  );
  const agentCapacityClaims = await Promise.all(
    agentClaimTaskIds.map((taskId, index) =>
      repository.claimQueuedTask({
        taskId,
        leaseToken: `${idPrefix}-agent-capacity-claim-${index + 1}`,
        now,
        maxRunningPerApp,
        maxRunningPerAgent,
      }),
    ),
  );
  const agentRunningTasks = await repository.listTasks({
    appId,
    agentId,
    kind: 'mcp_tool_call',
    statuses: ['running'],
    limit: 100,
  });

  await Promise.all(
    Array.from({ length: maxRunningPerApp - 1 }, (_, index) =>
      repository.createTask(
        taskInput(`app-running-seed-${index + 1}`, {
          taskAgentId: appScopedAgentIds[index],
          kind: 'delegated_agent',
          status: 'running',
        }),
      ),
    ),
  );
  const appClaimAgents = appScopedAgentIds.slice(
    maxRunningPerApp - 1,
    maxRunningPerApp + 1,
  );
  const appClaimTaskIds = appClaimAgents.map(
    (_, index) => `${idPrefix}-app-capacity-queued-${index + 1}`,
  );
  await Promise.all(
    appClaimAgents.map((taskAgentId, index) =>
      repository.createTask(
        taskInput(`app-capacity-queued-${index + 1}`, {
          taskAgentId,
          kind: 'delegated_agent',
        }),
      ),
    ),
  );
  const appCapacityClaims = await Promise.all(
    appClaimTaskIds.map((taskId, index) =>
      repository.claimQueuedTask({
        taskId,
        leaseToken: `${idPrefix}-app-capacity-claim-${index + 1}`,
        now,
        maxRunningPerApp,
        maxRunningPerAgent: maxRunningPerApp,
      }),
    ),
  );
  const appRunningTasks = await repository.listTasks({
    appId,
    kind: 'delegated_agent',
    statuses: ['running'],
    limit: 100,
  });

  return {
    admissions,
    backlog,
    appAdmissions,
    appBacklog,
    scopedAdmissions,
    scopedActiveTasks,
    claims,
    claimTaskId,
    agentCapacityClaims,
    agentRunningTasks,
    appCapacityClaims,
    appRunningTasks,
  };
}

export async function expectAsyncTaskRepositoryContract(
  options: AsyncTaskRepositoryContractOptions,
): Promise<void> {
  const evidence = await exerciseAsyncTaskRepositoryContract(options);
  const maxBacklogPerAgent =
    options.maxBacklogPerAgent ?? DEFAULT_MAX_BACKLOG_PER_AGENT;
  const maxBacklogPerApp =
    options.maxBacklogPerApp ?? DEFAULT_MAX_BACKLOG_PER_APP;
  const maxRunningPerAgent =
    options.maxRunningPerAgent ?? DEFAULT_MAX_RUNNING_PER_AGENT;
  const maxRunningPerApp =
    options.maxRunningPerApp ?? DEFAULT_MAX_RUNNING_PER_APP;
  const admitted = evidence.admissions.filter(
    (task): task is AsyncTaskRecord => task !== null,
  );
  const appAdmitted = evidence.appAdmissions.filter(
    (task): task is AsyncTaskRecord => task !== null,
  );
  const scopedAdmitted = evidence.scopedAdmissions.filter(
    (result) => result.admitted,
  );
  const scopedRejected = evidence.scopedAdmissions.filter(
    (result) => !result.admitted,
  );
  const claimed = evidence.claims.filter(
    (task): task is AsyncTaskRecord => task !== null,
  );
  const agentCapacityClaimed = evidence.agentCapacityClaims.filter(
    (task): task is AsyncTaskRecord => task !== null,
  );
  const appCapacityClaimed = evidence.appCapacityClaims.filter(
    (task): task is AsyncTaskRecord => task !== null,
  );

  expect(admitted).toHaveLength(1);
  expect(evidence.backlog).toHaveLength(maxBacklogPerAgent);
  expect(appAdmitted).toHaveLength(1);
  expect(evidence.appBacklog).toHaveLength(maxBacklogPerApp);
  expect(scopedAdmitted).toHaveLength(1);
  expect(scopedRejected).toHaveLength(1);
  expect(scopedAdmitted[0]).toMatchObject({
    admitted: true,
    task: { status: 'queued' },
    staleTasks: [],
  });
  expect(scopedRejected[0]).toMatchObject({
    admitted: false,
    task: { id: scopedAdmitted[0]?.task.id, status: 'queued' },
    staleTasks: [],
  });
  expect(evidence.scopedActiveTasks).toHaveLength(1);
  expect(evidence.scopedActiveTasks[0]?.id).toBe(scopedAdmitted[0]?.task.id);
  expect(claimed).toHaveLength(1);
  expect(claimed[0]).toMatchObject({
    id: evidence.claimTaskId,
    status: 'running',
  });
  expect(agentCapacityClaimed).toHaveLength(1);
  expect(evidence.agentRunningTasks).toHaveLength(maxRunningPerAgent);
  expect(evidence.agentRunningTasks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: agentCapacityClaimed[0]?.id,
        status: 'running',
      }),
    ]),
  );
  expect(appCapacityClaimed).toHaveLength(1);
  expect(evidence.appRunningTasks).toHaveLength(maxRunningPerApp);
  expect(evidence.appRunningTasks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: appCapacityClaimed[0]?.id,
        status: 'running',
      }),
    ]),
  );
}
