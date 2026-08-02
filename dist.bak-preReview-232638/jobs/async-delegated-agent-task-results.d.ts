import { type AsyncTaskStatusCount, toPublicAsyncTaskDto } from '../domain/ports/async-tasks.js';
export declare function activeChildCount(counts: AsyncTaskStatusCount[]): number;
export declare function childTaskResult(counts: AsyncTaskStatusCount[], terminalChildren: ReturnType<typeof toPublicAsyncTaskDto>[]): {
    summary: string;
    hasFailure: boolean;
    terminalChildren: ReturnType<typeof toPublicAsyncTaskDto>[];
};
