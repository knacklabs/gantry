export type AsyncTaskKind = 'async_command' | 'delegated_agent';

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
  currentPhase?: string | null;
  lastProgress?: string | null;
  lastToolSummary?: string | null;
  blocker?: string | null;
  pendingSteeringCount?: number;
  consumedSteeringCount?: number;
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

export interface AsyncTaskListFilter {
  appId: string;
  agentId?: string;
  conversationId?: string | null;
  threadId?: string | null;
  parentRunId?: string | null;
  parentTaskId?: string | null;
  statuses?: AsyncTaskStatus[];
  limit?: number;
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

export interface AsyncTaskRepository {
  createTask(input: AsyncTaskCreateInput): Promise<AsyncTaskRecord>;
  createTaskWithAdmission?(
    input: AsyncTaskCreateInput,
    admission: {
      activeStatuses: AsyncTaskStatus[];
      maxActivePerApp: number;
      maxActivePerAgent: number;
    },
  ): Promise<
    | { ok: true; task: AsyncTaskRecord }
    | { ok: false; reason: 'app_capacity' | 'agent_capacity' }
  >;
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
  return {
    id: task.id,
    kind: task.kind,
    status: task.status,
    summary: task.summary,
    outputSummary: task.outputSummary,
    errorSummary: task.errorSummary,
    ...publicProgress(task),
    receiptLines: receiptLines(task.receiptJson),
    allowedActions: isAsyncTaskTerminal(task.status)
      ? ['get', 'list']
      : ['get', 'list', 'cancel'],
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    terminalAt: task.terminalAt,
  };
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

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}
