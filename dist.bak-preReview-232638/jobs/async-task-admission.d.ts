import type { AsyncTaskCreateInput, AsyncTaskRecord, AsyncTaskRepository } from '../domain/ports/async-tasks.js';
export declare function createAdmittedAsyncTask(input: {
    repository: AsyncTaskRepository;
    task: AsyncTaskCreateInput;
}): Promise<{
    ok: true;
    task: AsyncTaskRecord;
} | {
    ok: false;
    message: string;
}>;
