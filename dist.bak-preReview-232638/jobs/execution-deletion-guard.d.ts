type ExecutionDeletionGuardLogger = {
    debug(metadata: Record<string, unknown>, message: string): void;
    info(metadata: Record<string, unknown>, message: string): void;
};
export declare function createJobExecutionDeletionGuard(input: {
    jobId: string;
    runId: string;
    nowMs: () => number;
    getJobById: (jobId: string) => Promise<unknown>;
    log: ExecutionDeletionGuardLogger;
}): {
    isJobDeleted: (force?: boolean) => Promise<boolean>;
    resetDeliveryDeletionCheck(): void;
    shouldSuppressDelivery(): Promise<boolean>;
    readonly deletedDuringRun: boolean;
};
export {};
