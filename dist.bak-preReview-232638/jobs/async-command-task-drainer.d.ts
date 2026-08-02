import type { AsyncTaskRecord, AsyncTaskRepository } from '../domain/ports/async-tasks.js';
import type { AsyncCommandLaunchControl } from './async-command-task-service.js';
import type { PendingAsyncTaskExecution } from './async-command-task-queue-types.js';
export declare function drainQueuedAsyncTasks(input: {
    repository: AsyncTaskRepository;
    pending: Map<string, PendingAsyncTaskExecution>;
    active: Map<string, AbortController>;
    limits: {
        perApp: number;
        perAgent: number;
    };
    executeCommand: (task: AsyncTaskRecord, command: string, taskInput: PendingAsyncTaskExecution['input'], controller: AbortController, launchControl: AsyncCommandLaunchControl) => Promise<void>;
}): Promise<void>;
