export declare const MEMORY_DREAM_RUN_TIMEOUT_MS: number;
export declare const MEMORY_DREAM_SYSTEM_JOB_TIMEOUT_MS: number;
export declare const MEMORY_DREAM_SYSTEM_JOB_FINALIZATION_GRACE_MS = 60000;
export declare const MEMORY_BOUNDARY_COLLECTION_TIMEOUT_MS = 30000;
export declare class MemoryOperationTimeoutError extends Error {
    readonly code = "MEMORY_OPERATION_TIMEOUT";
    constructor(message: string);
}
export declare function memoryDreamRunLeaseExpiresAt(startedAt: string, deadlineAtMs?: number): string;
export declare function abortReason(signal: AbortSignal): Error;
export declare function isMemoryOperationTimeoutError(error: unknown): error is MemoryOperationTimeoutError;
export declare function normalizeMemoryTimeoutMs(value: number | null | undefined, fallbackMs: number): number;
export declare function createMemoryOperationDeadline(input: {
    timeoutMs?: number;
    label: string;
    parentSignal?: AbortSignal;
    nowMs?: () => number;
}): {
    signal: AbortSignal;
    deadlineAtMs?: number;
    remainingTimeoutMs: () => number | undefined;
    throwIfExpired: () => void;
    dispose: () => void;
};
export declare function runWithMemoryOperationTimeout<T>(operation: (signal: AbortSignal) => Promise<T>, input: {
    timeoutMs?: number;
    label: string;
    parentSignal?: AbortSignal;
}): Promise<T>;
