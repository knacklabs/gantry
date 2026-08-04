import type { MemoryIpcResponse } from '@gantry/contracts';
type DeadlineRequest = {
    requestId: string;
    deadlineAtMs?: number;
};
export declare function remainingMemoryBudgetMs(request: DeadlineRequest, nowMs: () => number): number | undefined;
export declare function assertMemoryRequestNotExpired(request: DeadlineRequest, nowMs: () => number): void;
export declare function hasEnoughMemoryBudget(request: DeadlineRequest, nowMs: () => number): boolean;
export declare function runWithinMemoryDeadline<T>(request: DeadlineRequest, work: (signal: AbortSignal, timeoutMs?: number) => Promise<T>, nowMs: () => number): Promise<{
    status: 'completed';
    value: T;
} | {
    status: 'deadline_exceeded';
}>;
export declare function deadlineUnavailableResponse(request: DeadlineRequest, provider: string): MemoryIpcResponse;
export {};
