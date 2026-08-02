import type { AsyncTaskRecord, AsyncTaskRepository } from '../domain/ports/async-tasks.js';
export declare function refreshDelegatedCancellationReceipt(input: {
    repository: AsyncTaskRepository;
    parent: AsyncTaskRecord;
    alreadyCancelled: number;
    cancelChildTasks: (parent: AsyncTaskRecord) => Promise<{
        ok: true;
        cancelled: number;
    } | {
        ok: false;
        message: string;
    }>;
}): Promise<void>;
export declare function cancelQueuedTask(input: {
    repository: AsyncTaskRepository;
    task: AsyncTaskRecord;
    transitionTask?: AsyncTaskRepository['transitionTask'];
}): Promise<{
    ok: boolean;
    message: string;
}>;
