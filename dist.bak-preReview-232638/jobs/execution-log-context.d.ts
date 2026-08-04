import type { Job } from '../domain/types.js';
export interface ActiveJobRunContext {
    job: Job;
    runId: string;
    scheduledFor: string;
}
export declare function runActiveJobWithLogContext(input: {
    requestedJob: Job;
    dispatch?: {
        runId?: string | null;
        scheduledFor?: string | null;
    };
    getJobById: (jobId: string) => Promise<Job | null | undefined>;
    run: (context: ActiveJobRunContext) => Promise<void>;
}): Promise<void>;
