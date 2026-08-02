import type { Job } from '../domain/types.js';
export declare function computeNextJobRun(job: Pick<Job, 'schedule_value'> & {
    schedule_type: string;
}, scheduledFor: string | null): string | null;
