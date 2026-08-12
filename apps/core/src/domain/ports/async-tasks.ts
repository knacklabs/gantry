export type AsyncTaskKind =
  | 'async_command'
  | 'delegated_agent'
  | 'mcp_tool_call'
  | 'external_capability'
  | 'session_compaction';

export type AsyncTaskStatus =
  | 'queued'
  | 'running'
  | 'needs_attention'
  | 'waiting_external'
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

export type AgentFailureCode =
  | 'structured_output_validation_failed'
  | 'completion_continuation_failed'
  | 'model_transport_failed';

export interface ModelTransportFailureMetadata {
  source: 'provider' | 'model_client' | 'gantry_timeout' | 'gantry';
  phase: 'connect' | 'stream';
  providerId: string;
  responseStarted: boolean;
  httpStatus?: number;
}

export interface AgentFailureMetadata {
  type: AgentFailureType;
  code?: AgentFailureCode;
  attemptedAction: string;
  partialResult?: string | null;
  transport?: ModelTransportFailureMetadata;
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
  idempotencyKey?: string | null;
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
  taskKey?: string;
  kind: AsyncTaskKind;
  status: AsyncTaskStatus;
  summary?: string | null;
  outputSummary?: string | null;
  errorSummary?: string | null;
  resultRef?: string;
  result?: Record<string, unknown>;
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
  idempotencyKey?: string | null;
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
  createTaskWithBacklogAdmission(
    input: AsyncTaskBacklogAdmissionInput,
  ): Promise<AsyncTaskRecord | null>;
  createTaskWithScopedAdmission(
    input: AsyncTaskScopedAdmissionInput,
  ): Promise<AsyncTaskScopedAdmissionResult>;
  createTaskIdempotently(input: AsyncTaskCreateInput): Promise<{
    task: AsyncTaskRecord;
    created: boolean;
  }>;
  getTaskByIdempotencyKey(input: {
    appId: string;
    kind: AsyncTaskKind;
    idempotencyKey: string;
  }): Promise<AsyncTaskRecord | null>;
  claimQueuedTask(input: AsyncTaskClaimInput): Promise<AsyncTaskRecord | null>;
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
    ...(typeof task.privateCorrelationJson.taskKey === 'string'
      ? { taskKey: task.privateCorrelationJson.taskKey }
      : {}),
    kind: task.kind,
    status: task.status,
    summary: task.summary,
    outputSummary: task.outputSummary,
    errorSummary: task.errorSummary,
    ...(task.kind === 'external_capability' &&
    typeof task.privateCorrelationJson.resultRef === 'string'
      ? { resultRef: task.privateCorrelationJson.resultRef }
      : {}),
    ...(task.kind === 'external_capability' &&
    isRecord(task.privateCorrelationJson.result)
      ? { result: task.privateCorrelationJson.result }
      : {}),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
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
  const transport = publicTransportFailure(failure.transport);
  return {
    type: type as AgentFailureType,
    ...(failure.code === 'structured_output_validation_failed' ||
    failure.code === 'completion_continuation_failed' ||
    failure.code === 'model_transport_failed'
      ? { code: failure.code }
      : {}),
    attemptedAction,
    partialResult: stringValue(failure.partialResult),
    ...(transport ? { transport } : {}),
  };
}

function publicTransportFailure(
  value: unknown,
): ModelTransportFailureMetadata | null {
  const transport = record(value);
  const source = transport.source;
  const phase = transport.phase;
  const providerId = stringValue(transport.providerId);
  if (
    !['provider', 'model_client', 'gantry_timeout', 'gantry'].includes(
      typeof source === 'string' ? source : '',
    ) ||
    !['connect', 'stream'].includes(typeof phase === 'string' ? phase : '') ||
    !providerId ||
    typeof transport.responseStarted !== 'boolean'
  ) {
    return null;
  }
  return {
    source: source as ModelTransportFailureMetadata['source'],
    phase: phase as ModelTransportFailureMetadata['phase'],
    providerId,
    responseStarted: transport.responseStarted,
    ...(typeof transport.httpStatus === 'number'
      ? { httpStatus: transport.httpStatus }
      : {}),
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
  const lines = [receipt.completed];
  if (receipt.used !== 'none') lines.push(`I used ${receipt.used}.`);
  if (receipt.changed !== 'none') lines.push(`I changed ${receipt.changed}.`);
  if (receipt.delegated === 'yes') {
    lines.push(
      `I delegated part of the work; ${receipt.subtasks ?? 'no subtask totals were reported'}.`,
    );
  }
  if (receipt.needsAttention !== 'none') {
    lines.push(`I need your attention: ${receipt.needsAttention}`);
  }
  return lines;
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
