import type { AsyncTaskBacklogAdmissionInput, AsyncTaskClaimInput, AsyncTaskCreateInput, AsyncTaskListFilter, AsyncTaskReceipt, AsyncTaskRecord, AsyncTaskRepository, AsyncTaskScopedAdmissionInput, AsyncTaskScopedAdmissionResult, AsyncTaskStatusCount, AsyncTaskTransitionInput } from '../../../../domain/ports/async-tasks.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
export declare class PostgresAsyncTaskRepository implements AsyncTaskRepository {
    private readonly db;
    constructor(db: CanonicalDb);
    createTask(input: AsyncTaskCreateInput): Promise<AsyncTaskRecord>;
    createTaskWithBacklogAdmission(input: AsyncTaskBacklogAdmissionInput): Promise<AsyncTaskRecord | null>;
    createTaskWithScopedAdmission(input: AsyncTaskScopedAdmissionInput): Promise<AsyncTaskScopedAdmissionResult>;
    claimQueuedTask(input: AsyncTaskClaimInput): Promise<AsyncTaskRecord | null>;
    getTask(taskId: string): Promise<AsyncTaskRecord | null>;
    listTasks(filter: AsyncTaskListFilter): Promise<AsyncTaskRecord[]>;
    countTasksByStatus(filter: Omit<AsyncTaskListFilter, 'limit'>): Promise<AsyncTaskStatusCount[]>;
    updateTaskReceipt(taskId: string, receipt: AsyncTaskReceipt, now: string): Promise<AsyncTaskRecord | null>;
    transitionTask(input: AsyncTaskTransitionInput): Promise<AsyncTaskRecord | null>;
}
