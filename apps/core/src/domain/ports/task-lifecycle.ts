export type AgentTodoStatus =
  | 'pending'
  | 'inProgress'
  | 'completed'
  | 'blocked';

export type DelegatedTaskStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export const DELEGATED_TASK_TERMINAL_STATUSES = [
  'completed',
  'failed',
  'cancelled',
] as const satisfies readonly DelegatedTaskStatus[];

export interface AgentTodoItem {
  id: string;
  title: string;
  status: AgentTodoStatus;
  taskId?: string;
  note?: string;
}

/** Channel-agnostic payload for rendering an agent's live todo/plan. */
export interface AgentTodoRender {
  summary: string | null;
  items: AgentTodoItem[];
  threadId?: string | null;
  updatedAt?: string;
}

/**
 * Optional channel capability: render (and live-update in place) the agent's
 * todo/plan for a conversation. Channels that do not implement it are skipped.
 */
export interface AgentTodoSink {
  renderAgentTodo(jid: string, render: AgentTodoRender): Promise<void>;
}

export interface AgentTodoUpdate {
  id: string;
  appId: string;
  agentId: string;
  principalId: string;
  conversationId: string;
  threadId: string | null;
  parentRunId: string | null;
  runHandle: string | null;
  seq: number;
  summary: string | null;
  items: AgentTodoItem[];
  createdAt: string;
}

export interface DelegatedTaskReceipt {
  completed: string;
  used: string;
  changed: string;
  delegated: 'yes';
  needsAttention: string;
}

export interface DelegatedTask {
  id: string;
  appId: string;
  agentId: string;
  principalId: string;
  conversationId: string;
  threadId: string | null;
  parentRunId: string | null;
  runHandle: string | null;
  idempotencyKey: string;
  capabilityScope: string;
  ownerWorkerId: string | null;
  leaseToken: string | null;
  fencingVersion: number | null;
  status: DelegatedTaskStatus;
  providerCorrelation: Record<string, unknown>;
  progressCursor: string | null;
  title: string;
  task: string;
  expectedOutput: string;
  context: string | null;
  resultSummary: string | null;
  errorSummary: string | null;
  terminalReceipt: DelegatedTaskReceipt | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

export interface DelegatedTaskScope {
  appId: string;
  agentId: string;
  principalId: string;
  conversationId: string;
  threadId?: string | null;
  parentRunId?: string | null;
  runHandle?: string | null;
}

export interface DelegatedTaskFence {
  leaseToken?: string | null;
  workerInstanceId?: string | null;
  fencingVersion?: number | null;
}

export interface TaskLifecycleRepository {
  recordTodoUpdate(input: {
    id: string;
    scope: DelegatedTaskScope;
    summary?: string | null;
    items: AgentTodoItem[];
    idempotencyKey: string;
    fence?: DelegatedTaskFence;
    fencingVersion?: number | null;
    now?: string;
  }): Promise<
    | { outcome: 'created' | 'replayed'; update: AgentTodoUpdate }
    | { outcome: 'stale_fence' }
  >;

  launchDelegatedTask(input: {
    id: string;
    scope: DelegatedTaskScope;
    idempotencyKey: string;
    capabilityScope: 'AgentDelegation';
    ownerWorkerId?: string | null;
    fence?: DelegatedTaskFence;
    title: string;
    task: string;
    expectedOutput: string;
    context?: string | null;
    now?: string;
  }): Promise<
    | { outcome: 'created' | 'replayed'; task: DelegatedTask }
    | { outcome: 'stale_fence' }
  >;

  getDelegatedTask(input: {
    taskId: string;
    scope: DelegatedTaskScope;
    fence?: DelegatedTaskFence;
    now?: string;
  }): Promise<
    | { outcome: 'found'; task: DelegatedTask }
    | { outcome: 'not_found' | 'forbidden' | 'stale_fence' }
  >;

  cancelDelegatedTask(input: {
    taskId: string;
    scope: DelegatedTaskScope;
    fence?: DelegatedTaskFence;
    reason?: string | null;
    now?: string;
  }): Promise<
    | { outcome: 'cancelled' | 'already_terminal'; task: DelegatedTask }
    | { outcome: 'not_found' | 'forbidden' | 'stale_fence' }
  >;
}
