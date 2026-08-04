import type { Job } from '../../domain/types.js';
import type { JobManagementServiceDeps } from './job-management-types.js';
import { type JobReadinessInput, type JobReadinessResult } from './job-readiness-service.js';
export declare function evaluateManagedJobReadiness(input: {
    deps: JobManagementServiceDeps;
    job: JobReadinessInput['job'] & Partial<Pick<Job, 'session_id'>>;
    appId?: string;
    agentId?: string;
}): Promise<JobReadinessResult>;
export declare function applyJobReadinessToUpdates(updates: Partial<Job>, readiness: JobReadinessResult, options?: {
    clearPauseWhenActive?: boolean;
    mergedStatus?: Job['status'];
}): void;
export declare function pauseJobForSetup(input: {
    deps: JobManagementServiceDeps;
    job: Job;
    readiness: JobReadinessResult;
    appId?: string;
}): Promise<void>;
export declare function recordJobSetupRequired(input: {
    deps: JobManagementServiceDeps;
    job: Pick<Job, 'id' | 'workspace_key'> & Partial<Pick<Job, 'session_id' | 'execution_context' | 'thread_id'>>;
    readiness: JobReadinessResult;
    appId?: string;
}): Promise<void>;
export declare function setupBlockerDetails(setupState: NonNullable<Job['setup_state']>): string[];
