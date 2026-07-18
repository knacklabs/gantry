export type AsyncTaskKind =
  | 'async_command'
  | 'delegated_agent'
  | 'mcp_tool_call'
  | 'session_compaction';

export type AsyncTaskStatus =
  | 'queued'
  | 'running'
  | 'needs_attention'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

export interface AsyncTaskReceipt {
  completed: string;
  used: string;
  changed: string;
  delegated: 'yes' | 'no';
  subtasks?: string;
  needsAttention: string;
  callableAgentFollowUp?: { deliveredAt: string };
}

export type AgentFailureType =
  | 'execution'
  | 'timeout'
  | 'cancelled'
  | 'child_task';

export interface AgentFailureMetadata {
  type: AgentFailureType;
  attemptedAction: string;
  partialResult?: string | null;
}

export interface AsyncTaskRecord {
  id: string;
  appId: string;
  agentId: string;
  conversationId?: string | null;
  threadId?: string | null;
  parentRunId?: string | null;
  parentJobId?: string | null;
  parentJobRunId?: string | null;
  kind: AsyncTaskKind;
  status: AsyncTaskStatus;
  admissionClass: 'task';
  authoritySnapshotJson: Record<string, unknown>;
  privateCorrelationJson: Record<string, unknown>;
  leaseToken: string;
  fencingVersion: number;
  heartbeatAt?: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt?: string | null;
  terminalAt?: string | null;
  summary?: string | null;
  outputSummary?: string | null;
  errorSummary?: string | null;
  receiptJson?: AsyncTaskReceipt | null;
}

export interface PublicAsyncTaskDto {
  id: string;
  kind: AsyncTaskKind;
  status: AsyncTaskStatus;
  summary?: string | null;
  outputSummary?: string | null;
  errorSummary?: string | null;
  failure?: AgentFailureMetadata;
  terminalChildren?: PublicAsyncTaskDto[];
  currentPhase?: string | null;
  lastProgress?: string | null;
  lastToolSummary?: string | null;
  blocker?: string | null;
  pendingSteeringCount?: number;
  consumedSteeringCount?: number;
  heartbeatAt?: string | null;
  elapsedMs?: number | null;
  stdoutTail?: string | null;
  stderrTail?: string | null;
  receiptLines: string[];
  allowedActions: Array<'get' | 'list' | 'cancel'>;
  createdAt: string;
  updatedAt: string;
  terminalAt?: string | null;
}

export interface AsyncTaskCreateInput {
  id: string;
  appId: string;
  agentId: string;
  conversationId?: string | null;
  threadId?: string | null;
  parentRunId?: string | null;
  parentJobId?: string | null;
  parentJobRunId?: string | null;
  kind: AsyncTaskKind;
  status: AsyncTaskStatus;
  admissionClass: 'task';
  authoritySnapshotJson: Record<string, unknown>;
  privateCorrelationJson?: Record<string, unknown>;
  leaseToken: string;
  fencingVersion: number;
  summary?: string | null;
  now: string;
}

export interface AsyncTaskBacklogAdmissionInput {
  task: AsyncTaskCreateInput;
  maxBacklogPerApp: number;
  maxBacklogPerAgent: number;
  statuses: AsyncTaskStatus[];
}

export interface AsyncTaskScopedAdmissionInput {
  task: AsyncTaskCreateInput;
  activeStatuses: AsyncTaskStatus[];
  staleRunningBefore?: string;
  staleRunningStatus?: Extract<AsyncTaskStatus, 'failed' | 'timed_out'>;
  staleErrorSummary?: string;
}

export interface AsyncTaskScopedAdmissionResult {
  task: AsyncTaskRecord;
  admitted: boolean;
  staleTasks: AsyncTaskRecord[];
}

export interface AsyncTaskListFilter {
  appId: string;
  agentId?: string;
  kind?: AsyncTaskKind;
  conversationId?: string | null;
  providerAccountId?: string | null;
  threadId?: string | null;
  parentRunId?: string | null;
  parentTaskId?: string | null;
  statuses?: AsyncTaskStatus[];
  limit?: number;
  order?: 'newest_first' | 'oldest_first';
}

export interface AsyncTaskStatusCount {
  status: AsyncTaskStatus;
  count: number;
}

export interface AsyncTaskTransitionInput {
  taskId: string;
  leaseToken: string;
  fencingVersion: number;
  status: AsyncTaskStatus;
  now: string;
  heartbeatAt?: string | null;
  startedAt?: string | null;
  terminalAt?: string | null;
  privateCorrelationJson?: Record<string, unknown>;
  outputSummary?: string | null;
  errorSummary?: string | null;
  receiptJson?: AsyncTaskReceipt | null;
  expectedUpdatedAt?: string | null;
  expectedPrivateCorrelationJson?: Record<string, unknown>;
}

export interface AsyncTaskClaimInput {
  taskId: string;
  leaseToken: string;
  now: string;
  maxRunningPerApp: number;
  maxRunningPerAgent: number;
}

export interface AsyncTaskRepository {
  createTask(input: AsyncTaskCreateInput): Promise<AsyncTaskRecord>;
  createTaskWithBacklogAdmission?(
    input: AsyncTaskBacklogAdmissionInput,
  ): Promise<AsyncTaskRecord | null>;
  createTaskWithScopedAdmission?(
    input: AsyncTaskScopedAdmissionInput,
  ): Promise<AsyncTaskScopedAdmissionResult>;
  claimQueuedTask?(input: AsyncTaskClaimInput): Promise<AsyncTaskRecord | null>;
  getTask(taskId: string): Promise<AsyncTaskRecord | null>;
  listTasks(filter: AsyncTaskListFilter): Promise<AsyncTaskRecord[]>;
  countTasksByStatus(
    filter: Omit<AsyncTaskListFilter, 'limit'>,
  ): Promise<AsyncTaskStatusCount[]>;
  updateTaskReceipt(
    taskId: string,
    receipt: AsyncTaskReceipt,
    now: string,
  ): Promise<AsyncTaskRecord | null>;
  transitionTask(
    input: AsyncTaskTransitionInput,
  ): Promise<AsyncTaskRecord | null>;
}

const TERMINAL_STATUSES = new Set<AsyncTaskStatus>([
  'completed',
  'failed',
  'cancelled',
  'timed_out',
]);

export function isAsyncTaskTerminal(status: AsyncTaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function toPublicAsyncTaskDto(
  task: AsyncTaskRecord,
): PublicAsyncTaskDto {
  const failure = publicFailure(task.privateCorrelationJson.failure);
  const terminalChildren = publicTerminalChildren(
    task.privateCorrelationJson.terminalChildren,
  );
  return {
    id: task.id,
    kind: task.kind,
    status: task.status,
    summary: task.summary,
    outputSummary: task.outputSummary,
    errorSummary: task.errorSummary,
    ...(failure ? { failure } : {}),
    ...(terminalChildren.length > 0 ? { terminalChildren } : {}),
    ...publicProgress(task),
    ...publicInspection(task),
    receiptLines: receiptLines(task.receiptJson),
    allowedActions: isAsyncTaskTerminal(task.status)
      ? ['get', 'list']
      : ['get', 'list', 'cancel'],
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    terminalAt: task.terminalAt,
  };
}

function publicFailure(value: unknown): AgentFailureMetadata | null {
  const failure = record(value);
  const type = failure.type;
  const attemptedAction = stringValue(failure.attemptedAction);
  if (
    !['execution', 'timeout', 'cancelled', 'child_task'].includes(
      typeof type === 'string' ? type : '',
    ) ||
    !attemptedAction
  ) {
    return null;
  }
  return {
    type: type as AgentFailureType,
    attemptedAction,
    partialResult: stringValue(failure.partialResult),
  };
}

function publicTerminalChildren(value: unknown): PublicAsyncTaskDto[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is PublicAsyncTaskDto =>
        Boolean(
          entry &&
          typeof entry === 'object' &&
          typeof (entry as { id?: unknown }).id === 'string' &&
          typeof (entry as { status?: unknown }).status === 'string',
        ),
      )
    : [];
}

function receiptLines(receipt: AsyncTaskReceipt | null | undefined): string[] {
  if (!receipt) return [];
  if (isPureAnswerReceipt(receipt)) return [`Completed: ${receipt.completed}`];
  const lines = [
    `Completed: ${receipt.completed}`,
    `Used: ${receipt.used}`,
    `Changed: ${receipt.changed}`,
    `Delegated: ${receipt.delegated}`,
  ];
  if (receipt.delegated === 'yes') {
    lines.push(
      `Subtasks: ${receipt.subtasks ?? '0 completed, 0 failed, 0 cancelled'}`,
    );
  }
  lines.push(`Needs attention: ${receipt.needsAttention}`);
  return lines;
}

function isPureAnswerReceipt(receipt: AsyncTaskReceipt): boolean {
  return (
    receipt.used === 'none' &&
    receipt.changed === 'none' &&
    receipt.delegated === 'no' &&
    receipt.needsAttention === 'none'
  );
}

function publicProgress(
  task: AsyncTaskRecord,
): Pick<
  PublicAsyncTaskDto,
  | 'currentPhase'
  | 'lastProgress'
  | 'lastToolSummary'
  | 'blocker'
  | 'pendingSteeringCount'
  | 'consumedSteeringCount'
> {
  const progress = record(task.privateCorrelationJson.progress);
  const steering = Array.isArray(task.privateCorrelationJson.steering)
    ? task.privateCorrelationJson.steering
    : [];
  return {
    currentPhase: stringValue(progress.phase),
    lastProgress: stringValue(progress.lastProgress),
    lastToolSummary: stringValue(progress.lastToolSummary),
    blocker: stringValue(progress.blocker),
    pendingSteeringCount: steering.filter(
      (entry) => record(entry).status === 'pending',
    ).length,
    consumedSteeringCount: steering.filter(
      (entry) => record(entry).status === 'consumed',
    ).length,
  };
}

function publicInspection(
  task: AsyncTaskRecord,
): Pick<
  PublicAsyncTaskDto,
  'heartbeatAt' | 'elapsedMs' | 'stdoutTail' | 'stderrTail'
> {
  if (
    task.status !== 'running' ||
    (task.kind !== 'async_command' && task.kind !== 'mcp_tool_call')
  ) {
    return {
      heartbeatAt: null,
      elapsedMs: null,
      stdoutTail: null,
      stderrTail: null,
    };
  }
  const progress = record(task.privateCorrelationJson.progress);
  const startedAt = task.startedAt ?? task.createdAt;
  const startedMs = Date.parse(startedAt);
  const endMs =
    Date.parse(task.terminalAt ?? '') ||
    Date.parse(task.heartbeatAt ?? '') ||
    Date.parse(task.updatedAt) ||
    Date.now();
  const fallbackElapsedMs =
    Number.isFinite(startedMs) && endMs >= startedMs ? endMs - startedMs : null;
  return {
    heartbeatAt: task.heartbeatAt ?? null,
    elapsedMs: fallbackElapsedMs,
    stdoutTail:
      task.kind === 'async_command' ? stringValue(progress.stdoutTail) : null,
    stderrTail:
      task.kind === 'async_command' ? stringValue(progress.stderrTail) : null,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}
