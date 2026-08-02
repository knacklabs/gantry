import { type AsyncTaskRecord, type AsyncTaskKind, type AsyncTaskRepository, type PublicAsyncTaskDto } from '../domain/ports/async-tasks.js';
import { type StartDelegatedAgentTaskInput } from './async-delegated-agent-task.js';
import type { AsyncCommandTaskServiceOptions } from './async-command-task-queue-types.js';
import type { AsyncCommandRunner, StartAsyncCommandTaskInput, StartAsyncCommandTaskResult } from './async-command-task-types.js';
import { delegatedAgentFailureResult, type RecoverPendingDelegatedAgentFollowUpsInput } from './async-command-task-leaves.js';
export type { AsyncCommandLaunchControl, AsyncCommandProcessHandle, AsyncCommandRunner, AsyncCommandRunnerResult, StartAsyncCommandTaskInput, StartAsyncCommandTaskResult, } from './async-command-task-types.js';
export declare const ASYNC_TASK_STALE_AFTER_MS = 60000;
export declare class AsyncCommandTaskService {
    private readonly repository;
    private readonly runner;
    static readonly delegatedAgentFailureResult: typeof delegatedAgentFailureResult;
    private readonly active;
    private readonly pending;
    private readonly taskChanges;
    private readonly classifier;
    private readonly policy;
    private readonly terminateProcess;
    private readonly prepareRun;
    private readonly createRecoveredDelegatedAgentRun;
    private readonly completionMessageRepository;
    constructor(repository: AsyncTaskRepository, runner: AsyncCommandRunner, options?: AsyncCommandTaskServiceOptions);
    start(input: StartAsyncCommandTaskInput): Promise<StartAsyncCommandTaskResult>;
    startDelegatedAgent(input: StartDelegatedAgentTaskInput): Promise<import("./async-task-change-waiter.js").AsyncTaskCompletionStartResult>;
    private transitionTask;
    markDelegatedTaskAsyncFallback(input: {
        taskId: string;
        appId: string;
        agentId: string;
        conversationId?: string | null;
        providerAccountId?: string | null;
        threadId?: string | null;
    }): Promise<{
        taskId: string;
        status: Extract<import("../domain/ports/async-tasks.js").AsyncTaskStatus, "completed" | "cancelled" | "timed_out" | "failed">;
        result: string;
        error?: string;
    } | null>;
    get(taskId: string): Promise<PublicAsyncTaskDto | null>;
    getScoped(input: {
        taskId: string;
        appId: string;
        agentId: string;
        conversationId?: string | null;
        providerAccountId?: string | null;
        threadId?: string | null;
        parentTaskId?: string | null;
    }): Promise<PublicAsyncTaskDto | null>;
    list(input: {
        appId: string;
        agentId?: string;
        conversationId?: string | null;
        providerAccountId?: string | null;
        threadId?: string | null;
        parentRunId?: string | null;
        parentTaskId?: string | null;
        limit?: number;
    }): Promise<PublicAsyncTaskDto[]>;
    message(input: {
        taskId: string;
        appId: string;
        agentId: string;
        conversationId?: string | null;
        providerAccountId?: string | null;
        threadId?: string | null;
        parentTaskId?: string | null;
        message: string;
        deliver: (task: AsyncTaskRecord, message: string) => Promise<void> | void;
    }): Promise<{
        ok: boolean;
        message: string;
    }>;
    recoverStaleTasks(input: {
        appId: string;
        agentId?: string;
        staleAfterMs?: number;
        limit?: number;
        excludeKinds?: AsyncTaskKind[];
    }): Promise<number>;
    recoverQueuedTasks(input: {
        appId: string;
        agentId?: string;
        limit?: number;
    }): Promise<number>;
    cancel(input: string | {
        taskId: string;
        appId?: string;
        agentId?: string;
        conversationId?: string | null;
        providerAccountId?: string | null;
        threadId?: string | null;
        parentTaskId?: string | null;
    }): Promise<{
        ok: boolean;
        message: string;
    }>;
    private cancelChildTasks;
    private execute;
    private drainQueuedTasks;
    recoverPendingDelegatedAgentFollowUps(input: RecoverPendingDelegatedAgentFollowUpsInput): Promise<number>;
}
