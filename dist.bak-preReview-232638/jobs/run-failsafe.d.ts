import type { SchedulerDependencies } from './types.js';
type LoggerLike = {
    warn(input: unknown, message: string): void;
};
export declare function completeFailedRunFailsafe(input: {
    opsRepository: SchedulerDependencies['opsRepository'];
    jobId: string;
    runId: string;
    leaseToken: string;
    workerInstanceId: string;
    fencingVersion: number;
    recordRunnerControlEvent?: (eventType: 'terminal_state', payload: Record<string, unknown>) => Promise<void>;
    logger: LoggerLike;
}): Promise<void>;
export {};
