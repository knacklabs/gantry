import type { Job } from '../../domain/types.js';
import type { JobKind, SchedulerJobAccess } from './job-management-types.js';
export interface JobVisibilityFilter {
    appId?: string;
    access?: SchedulerJobAccess;
    agentId?: string;
    kind?: JobKind;
    conversationJid?: string;
}
export declare function isVisibleJob(job: Job, input: JobVisibilityFilter): boolean;
export declare function jobKindFor(job: Job): JobKind;
