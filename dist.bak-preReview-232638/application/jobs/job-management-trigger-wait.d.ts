import type { Job, JobManagementServiceDeps } from './job-management-types.js';
export interface CompletedTriggerRun {
    triggerId: string;
    runId: string;
    status: string;
    resultSummary: string | null;
    errorSummary: string | null;
}
export declare function waitForTriggerCompletion(input: {
    deps: JobManagementServiceDeps;
    appId: string;
    triggerId: string;
    timeoutMs: number;
    requireJob: (jobId: string) => Promise<Job>;
    assertJobAppAccess: (job: Job, appId: string) => Promise<void>;
}): Promise<CompletedTriggerRun>;
