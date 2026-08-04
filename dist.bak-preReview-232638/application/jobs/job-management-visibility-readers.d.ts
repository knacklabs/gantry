import type { Job, JobManagementServiceDeps, JobRun, SchedulerJobAccess } from './job-management-types.js';
export declare function createJobVisibilityReaders(input: {
    deps: JobManagementServiceDeps;
    listJobs: (scope: {
        appId?: string;
        access?: SchedulerJobAccess;
    }) => Promise<{
        jobs: Job[];
    }>;
}): {
    getVisibleJobForScopedRead: (lookup: {
        jobId: string;
        appId?: string;
        access?: SchedulerJobAccess;
    }) => Promise<Job | null>;
    visibleJobIdsArray: (scope: {
        appId?: string;
        access?: SchedulerJobAccess;
    }) => Promise<string[] | undefined>;
    filterRunsByVisibleJobs: (runs: JobRun[], scope: {
        appId?: string;
        access?: SchedulerJobAccess;
    }) => Promise<JobRun[]>;
};
