import type { JobManagementServiceDeps, SchedulerRunNowInput } from './job-management-types.js';
export declare function runSchedulerJobNowFromMcp(deps: JobManagementServiceDeps, input: SchedulerRunNowInput): Promise<{
    runId: string;
    queued: true;
    triggerId: string;
}>;
