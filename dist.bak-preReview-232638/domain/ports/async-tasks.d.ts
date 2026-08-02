export type AsyncTaskKind = 'async_command' | 'delegated_agent' | 'mcp_tool_call' | 'session_compaction';
export type AsyncTaskStatus = 'queued' | 'running' | 'needs_attention' | 'completed' | 'failed' | 'cancelled' | 'timed_out';
export interface AsyncTaskReceipt {
    completed: string;
    used: string;
    changed: string;
    delegated: 'yes' | 'no';
    subtasks?: string;
    needsAttention: string;
    callableAgentFollowUp?: {
        deliveredAt: string;
    };
}
export type AgentFailureType = 'execution' | 'timeout' | 'cancelled' | 'child_task';
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
    createTaskWithBacklogAdmission?(input: AsyncTaskBacklogAdmissionInput): Promise<AsyncTaskRecord | null>;
    createTaskWithScopedAdmission?(input: AsyncTaskScopedAdmissionInput): Promise<AsyncTaskScopedAdmissionResult>;
    claimQueuedTask?(input: AsyncTaskClaimInput): Promise<AsyncTaskRecord | null>;
    getTask(taskId: string): Promise<AsyncTaskRecord | null>;
    listTasks(filter: AsyncTaskListFilter): Promise<AsyncTaskRecord[]>;
    countTasksByStatus(filter: Omit<AsyncTaskListFilter, 'limit'>): Promise<AsyncTaskStatusCount[]>;
    updateTaskReceipt(taskId: string, receipt: AsyncTaskReceipt, now: string): Promise<AsyncTaskRecord | null>;
    transitionTask(input: AsyncTaskTransitionInput): Promise<AsyncTaskRecord | null>;
}
export declare function isAsyncTaskTerminal(status: AsyncTaskStatus): boolean;
export declare function toPublicAsyncTaskDto(task: AsyncTaskRecord): PublicAsyncTaskDto;
