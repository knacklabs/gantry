import type { Job } from '../domain/types.js';
import type { SchedulerDependencies, SchedulerDispatchPayload } from './types.js';
export declare function runJob(job: Job, deps: SchedulerDependencies, queueJid: string, dispatch?: SchedulerDispatchPayload, control?: {
    abortSignal?: AbortSignal;
}): Promise<void>;
