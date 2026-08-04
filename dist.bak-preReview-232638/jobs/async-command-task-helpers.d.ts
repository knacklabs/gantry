import type { AsyncTaskRecord, AsyncTaskRepository } from '../domain/ports/async-tasks.js';
import type { AsyncCommandLaunchControl, AsyncCommandProcessHandle } from './async-command-task-service.js';
export declare function readPersistedProcessHandle(value: unknown): AsyncCommandProcessHandle | null;
export declare function buildLaunchControl(taskId: string): AsyncCommandLaunchControl;
export declare function cleanupLaunchControl(launchControl: AsyncCommandLaunchControl): void;
export declare function terminateProcessHandle(handle: AsyncCommandProcessHandle): boolean;
export declare function isRecord(value: unknown): value is Record<string, unknown>;
export declare function taskTimestampMs(task: AsyncTaskRecord): number;
export declare function commandSummary(command: string): string;
export declare function truncate(value: string, limit?: number): string;
export interface AsyncCommandOutputSnapshot {
    stdoutTail?: string;
    stderrTail?: string;
}
export declare function persistProcessHandle(input: {
    repository: AsyncTaskRepository;
    task: AsyncTaskRecord;
    handle: AsyncCommandProcessHandle;
}): Promise<void>;
export declare function persistInspectionSnapshot(input: {
    repository: AsyncTaskRepository;
    task: AsyncTaskRecord;
    snapshot: AsyncCommandOutputSnapshot;
}): Promise<void>;
export declare function errorMessage(err: unknown): string;
export declare function isTimeoutError(err: unknown): boolean;
export declare function withLocalAdmissionLock<T>(repository: AsyncTaskRepository, fn: () => Promise<T>): Promise<T>;
export declare function taskInScope(task: AsyncTaskRecord, input: {
    appId: string;
    agentId?: string;
    conversationId?: string | null;
    providerAccountId?: string | null;
    threadId?: string | null;
    parentTaskId?: string | null;
}): boolean;
export declare function delegatedTaskAgentInScope(task: AsyncTaskRecord, agentId: string): boolean;
export declare function hasAsyncTaskRepository(deps: {
    getAsyncTaskRepository?: () => AsyncTaskRepository | undefined;
}): boolean;
