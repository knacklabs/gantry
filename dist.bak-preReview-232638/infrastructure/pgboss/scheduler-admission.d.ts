import type { Job } from '../../domain/types.js';
interface SchedulerDispatchPayloadLike {
    jobId: string;
}
export declare const SCHEDULER_BACKGROUND_DISPATCH_PRIORITY = 0;
export declare const SCHEDULER_MAINTENANCE_DISPATCH_PRIORITY = -1;
export interface SchedulerDispatchWithJob<TPayload extends SchedulerDispatchPayloadLike> {
    current: Job;
    payload: TPayload;
    order: number;
}
export declare function loadSchedulerDispatchesByAdmission<TPayload extends SchedulerDispatchPayloadLike>(input: {
    jobs: ReadonlyArray<{
        data?: TPayload | null;
    }>;
    getJobById: (jobId: string) => Promise<Job | null | undefined>;
}): Promise<Array<SchedulerDispatchWithJob<TPayload>>>;
export declare function schedulerDeliveryPriorityForJob(job: Pick<Job, 'id' | 'prompt'>): number;
export {};
