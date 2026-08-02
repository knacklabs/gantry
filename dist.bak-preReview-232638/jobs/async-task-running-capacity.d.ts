import type { AsyncTaskRecord, AsyncTaskRepository } from '../domain/ports/async-tasks.js';
export declare function hasAsyncTaskRunningCapacity(repository: AsyncTaskRepository, task: AsyncTaskRecord, limits: {
    perApp: number;
    perAgent: number;
}): Promise<boolean>;
