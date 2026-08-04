import type { SchedulerDependencies } from './types.js';
type LoggerLike = {
    warn(input: unknown, message: string): void;
};
export declare function createRunProviderMetadataUpdater(input: {
    opsRepository: SchedulerDependencies['opsRepository'];
    jobId: string;
    outerRunId: string;
    leaseToken?: string;
    workerInstanceId?: string;
    fencingVersion?: number;
    getSessionRunId: () => string | undefined;
    nowMs: () => number;
    logger: LoggerLike;
}): (metadata: {
    providerRunId?: string | null;
    providerSessionId?: string | null;
    force?: boolean;
}) => Promise<void>;
export {};
