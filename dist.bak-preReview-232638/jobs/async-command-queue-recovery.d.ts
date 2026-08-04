import type { AsyncTaskRecord, AsyncTaskRepository } from '../domain/ports/async-tasks.js';
import type { PendingAsyncTaskExecution } from './async-command-task-queue-types.js';
import type { StartDelegatedAgentTaskInput } from './async-delegated-agent-task.js';
export declare function recoverQueuedAsyncTasks(input: {
    repository: AsyncTaskRepository;
    pending: Map<string, PendingAsyncTaskExecution>;
    appId: string;
    agentId?: string;
    createDelegatedRun?: (task: AsyncTaskRecord, taskInput: Omit<StartDelegatedAgentTaskInput, 'run'>) => StartDelegatedAgentTaskInput['run'];
    cancelLinkedChildTasks: (parent: AsyncTaskRecord) => Promise<number>;
    waitForTaskChange?: (parent: AsyncTaskRecord, options: {
        signal: AbortSignal;
        timeoutMs: number;
    }) => Promise<void>;
    transitionTask: AsyncTaskRepository['transitionTask'];
    limit?: number;
}): Promise<number>;
