import type { AsyncTaskRecord, AsyncTaskStatus, PublicAsyncTaskDto } from '../../domain/ports/async-tasks.js';
export type CoreTaskLifecycleName = 'delegate_task' | 'task_get' | 'task_list' | 'task_cancel' | 'task_message';
export type CoreTaskLifecycleErrorCode = 'invalid_request' | 'unavailable' | 'cancelled' | 'failed' | 'not_found' | 'forbidden';
export interface CoreTaskLifecycleResult {
    ok: boolean;
    message: string;
    code?: CoreTaskLifecycleErrorCode;
    data?: unknown;
}
export type CoreTaskLifecycleBackend = {
    [Name in CoreTaskLifecycleName]: (input: Record<string, unknown>) => Promise<CoreTaskLifecycleResult>;
} & {
    owner?: CoreTaskOwner;
};
export interface CoreTaskOwner {
    appId: string;
    agentId: string;
    conversationId: string;
    providerAccountId?: string | null;
    threadId?: string | null;
}
export interface CoreTaskProcessHandle {
    pid: number;
    processGroupId?: number | null;
    detached: boolean;
    platform: NodeJS.Platform;
    ownerPid: number;
    startedAt: string;
    processStartId?: string;
}
export interface CoreDelegatedRunInput {
    task: AsyncTaskRecord;
    prompt: string;
    targetAgentId?: string;
    signal: AbortSignal;
    onProcessStarted?: (handle: CoreTaskProcessHandle) => Promise<void> | void;
    onProgress?: (summary: string) => Promise<void> | void;
    timeoutMs?: number;
}
export interface CoreDelegatedTaskCompletion {
    taskId: string;
    status: Extract<AsyncTaskStatus, 'completed' | 'cancelled' | 'timed_out' | 'failed'>;
    result: string;
    error?: string;
}
export interface CoreDelegatedTaskCompletionSubscription {
    wait(timeoutMs: number): Promise<CoreDelegatedTaskCompletion | null>;
}
export interface CoreTaskLifecycleService {
    getScoped(input: CoreTaskOwner & {
        taskId: string;
        parentTaskId?: string | null;
    }): Promise<PublicAsyncTaskDto | null>;
    list(input: CoreTaskOwner & {
        parentTaskId?: string | null;
        limit?: number;
    }): Promise<PublicAsyncTaskDto[]>;
    cancel(input: CoreTaskOwner & {
        taskId: string;
        parentTaskId?: string | null;
    }): Promise<{
        ok: boolean;
        message: string;
    }>;
    startDelegatedAgent(input: CoreTaskOwner & {
        parentRunId?: string | null;
        objective: string;
        context?: string | null;
        expectedOutput?: string | null;
        targetAgentId?: string;
        authorityToolName?: 'AgentDelegation';
        workspaceFolder: string;
        run(input: CoreDelegatedRunInput): Promise<{
            outputSummary?: string | null;
            errorSummary?: string | null;
        }>;
    }): Promise<{
        ok: true;
        task: PublicAsyncTaskDto;
        completion: CoreDelegatedTaskCompletionSubscription;
    } | {
        ok: false;
        message: string;
    }>;
    markDelegatedTaskAsyncFallback?(input: CoreTaskOwner & {
        taskId: string;
    }): Promise<CoreDelegatedTaskCompletion | null>;
    message(input: CoreTaskOwner & {
        taskId: string;
        parentTaskId?: string | null;
        message: string;
        deliver: (task: AsyncTaskRecord, message: string) => Promise<void> | void;
    }): Promise<{
        ok: boolean;
        message: string;
    }>;
}
export declare function createCoreTaskLifecycleBackend(input: {
    service: CoreTaskLifecycleService;
    owner: CoreTaskOwner;
    parentTaskId?: string | null;
    parentRunId?: string | null;
    authorityToolName?: 'AgentDelegation';
    enableDelegatedAsyncFollowUp?: boolean;
    workspaceFolder: string;
    runDelegatedAgent?: (input: CoreDelegatedRunInput) => Promise<{
        outputSummary?: string | null;
        errorSummary?: string | null;
    }>;
    deliverTaskMessage?: (task: AsyncTaskRecord, message: string) => Promise<void> | void;
}): CoreTaskLifecycleBackend;
export declare function coreTaskLifecycleResultText(result: CoreTaskLifecycleResult): string;
