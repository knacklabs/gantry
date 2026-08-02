import type { SchedulerDependencies } from './types.js';
export declare const DEFAULT_JOB_CLEANUP_AFTER_MS = 86400000;
export declare function normalizeCleanupAfterMs(value: number | undefined): number;
export declare function sweepCompletedOneTimeJobs(deps: SchedulerDependencies): Promise<boolean>;
