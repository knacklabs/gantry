import type { AsyncTaskRepository } from '../domain/ports/async-tasks.js';
import type { CoreDelegatedTaskCompletion, CoreDelegatedTaskCompletionSubscription } from '../application/core-tools/task-lifecycle.js';
export type AsyncTaskCompletionSubscription = CoreDelegatedTaskCompletionSubscription;
export type AsyncTaskCompletionStartResult = {
    ok: true;
    task: import('../domain/ports/async-tasks.js').PublicAsyncTaskDto;
    completion: AsyncTaskCompletionSubscription;
} | {
    ok: false;
    message: string;
};
export declare class AsyncTaskChangeWaiter {
    private readonly waiters;
    private readonly completionWaiters;
    notify(): void;
    wait(input: {
        signal: AbortSignal;
        timeoutMs: number;
    }): Promise<void>;
    subscribeCompletion(taskId: string): AsyncTaskCompletionSubscription;
    notifyCompletion(completion: CoreDelegatedTaskCompletion): void;
}
export declare function asyncTaskChangeWaiterFor(repository: AsyncTaskRepository): AsyncTaskChangeWaiter;
export declare function notifyAsyncTaskChange(repository: AsyncTaskRepository): void;
export declare function subscribeAsyncTaskCompletion(repository: AsyncTaskRepository, taskId: string): AsyncTaskCompletionSubscription;
export declare function notifyAsyncTaskCompletion(repository: AsyncTaskRepository, updated: unknown, taskId: string, input: {
    status: CoreDelegatedTaskCompletion['status'];
    output: string;
    error?: string;
}): void;
