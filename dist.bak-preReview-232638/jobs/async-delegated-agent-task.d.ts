import { type AsyncTaskCreateInput, type AsyncTaskRecord, type AsyncTaskRepository } from '../domain/ports/async-tasks.js';
import { type AsyncCommandProcessHandle, type AsyncCommandRunnerResult } from './async-command-task-service.js';
import type { AsyncTaskCompletionStartResult } from './async-task-change-waiter.js';
export interface StartDelegatedAgentTaskInput {
    appId: string;
    agentId: string;
    conversationId: string;
    providerAccountId?: string | null;
    threadId?: string | null;
    parentRunId?: string | null;
    objective: string;
    context?: string | null;
    expectedOutput?: string | null;
    targetAgentId?: string;
    authorityToolName?: 'AgentDelegation';
    workspaceFolder: string;
    run(input: {
        task: AsyncTaskRecord;
        prompt: string;
        targetAgentId?: string;
        signal: AbortSignal;
        onProcessStarted?: (handle: AsyncCommandProcessHandle) => Promise<void> | void;
        onProgress?: (summary: string) => Promise<void> | void;
    }): Promise<AsyncCommandRunnerResult>;
}
export type PendingDelegatedAgentExecution = {
    task: AsyncTaskRecord;
    command: string;
    input: never;
    controller: AbortController;
    launchControl: never;
    delegated: {
        taskInput: StartDelegatedAgentTaskInput;
        cancelLinkedChildTasks: (parent: AsyncTaskRecord) => Promise<number>;
        waitForTaskChange?: (parent: AsyncTaskRecord, options: {
            signal: AbortSignal;
            timeoutMs: number;
        }) => Promise<void>;
        transitionTask: AsyncTaskRepository['transitionTask'];
    };
};
export declare function startDelegatedAgentTask(input: {
    taskInput: StartDelegatedAgentTaskInput;
    repository: AsyncTaskRepository;
    active: Map<string, AbortController>;
    createTask: (input: AsyncTaskCreateInput) => Promise<AsyncTaskRecord>;
    queueTask: (execution: PendingDelegatedAgentExecution) => void;
    recoverStaleTasks: (input: {
        appId: string;
    }) => Promise<number>;
    cancelLinkedChildTasks: (parent: AsyncTaskRecord) => Promise<number>;
    waitForTaskChange?: (parent: AsyncTaskRecord, options: {
        signal: AbortSignal;
        timeoutMs: number;
    }) => Promise<void>;
    transitionTask: AsyncTaskRepository['transitionTask'];
}): Promise<AsyncTaskCompletionStartResult>;
export declare function sendDelegatedAgentTaskMessage(input: {
    taskId: string;
    appId: string;
    agentId: string;
    conversationId?: string | null;
    providerAccountId?: string | null;
    threadId?: string | null;
    parentTaskId?: string | null;
    message: string;
    repository: AsyncTaskRepository;
    deliver: (task: AsyncTaskRecord, message: string) => Promise<void> | void;
}): Promise<{
    ok: boolean;
    message: string;
}>;
export declare function executeDelegatedAgentTask(input: {
    task: AsyncTaskRecord;
    taskInput: StartDelegatedAgentTaskInput;
    controller: AbortController;
    repository: AsyncTaskRepository;
    active: Map<string, AbortController>;
    cancelLinkedChildTasks: (parent: AsyncTaskRecord) => Promise<number>;
    waitForTaskChange?: (parent: AsyncTaskRecord, options: {
        signal: AbortSignal;
        timeoutMs: number;
    }) => Promise<void>;
    transitionTask: AsyncTaskRepository['transitionTask'];
}): Promise<void>;
