import { type AgentFailureMetadata, type AsyncTaskRecord, type AsyncTaskRepository, type AsyncTaskStatus } from '../domain/ports/async-tasks.js';
import type { AsyncCommandTaskServiceOptions } from './async-command-task-queue-types.js';
import type { AsyncCommandRunnerResult } from './async-command-task-types.js';
import { drainQueuedAsyncTasks } from './async-command-task-drainer.js';
export declare function drainQueuedCommandTasks(input: Omit<Parameters<typeof drainQueuedAsyncTasks>[0], 'limits'>): Promise<void>;
export declare function delegatedAgentFailureResult(output: {
    result: string | null;
    error?: string;
    failure?: AgentFailureMetadata;
}, latestResult: string | null, attemptedAction: string): AsyncCommandRunnerResult;
export declare function isAgentFacingTask(task: AsyncTaskRecord): boolean;
export declare function delegatedCompletion(task: AsyncTaskRecord): {
    taskId: string;
    status: Extract<AsyncTaskStatus, 'completed' | 'cancelled' | 'timed_out' | 'failed'>;
    result: string;
    error?: string;
};
export declare function recoverPendingDelegatedAgentFollowUps(input: {
    repository: AsyncTaskRepository;
    completionMessageRepository: NonNullable<AsyncCommandTaskServiceOptions['completionMessageRepository']>;
    appId: string;
    agentId?: string;
    limit?: number;
}): Promise<number>;
export type RecoverPendingDelegatedAgentFollowUpsInput = Pick<Parameters<typeof recoverPendingDelegatedAgentFollowUps>[0], 'appId' | 'agentId' | 'limit'>;
