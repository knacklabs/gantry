import type { Job, JobEvent, JobManagementServiceDeps, JobRun, SchedulerJobAccess } from './job-management-types.js';
type ScopedVisibilityInput = {
    appId?: string;
    access?: SchedulerJobAccess;
};
type ScopedReadJobLookup = ScopedVisibilityInput & {
    jobId: string;
};
interface JobVisibilityReaders {
    getVisibleJobForScopedRead(input: ScopedReadJobLookup): Promise<Job | null>;
    visibleJobIdsArray(input: ScopedVisibilityInput): Promise<string[] | undefined>;
    filterRunsByVisibleJobs(runs: JobRun[], input: ScopedVisibilityInput): Promise<JobRun[]>;
}
export declare function listManagedJobRuns(input: {
    deps: JobManagementServiceDeps;
    visibility: JobVisibilityReaders;
    appId?: string;
    access?: SchedulerJobAccess;
    jobId?: string;
    limit?: number;
}): Promise<{
    runs: JobRun[];
}>;
export declare function listManagedJobEvents(input: {
    deps: JobManagementServiceDeps;
    visibility: JobVisibilityReaders;
    appId?: string;
    access?: SchedulerJobAccess;
    jobId?: string;
    runId?: string;
    eventType?: string;
    sinceId?: number;
    since?: string;
    limit?: number;
}): Promise<{
    events: JobEvent[];
}>;
export declare function listManagedDeadLetterRuns(input: {
    deps: JobManagementServiceDeps;
    visibility: JobVisibilityReaders;
    appId?: string;
    access?: SchedulerJobAccess;
    limit?: number;
}): Promise<{
    deadLetterRuns: JobRun[];
}>;
export {};
