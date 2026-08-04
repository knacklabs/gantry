import type { Job } from '../../domain/types.js';
import type { SchedulerJobAccess } from './job-management-types.js';
export declare function normalizeOptional(value: unknown): string | undefined;
export declare function canAccessSchedulerJob(job: Job, access: SchedulerJobAccess): boolean;
export declare function assertSchedulerJobAccess(_job: Job, access: SchedulerJobAccess): void;
export declare function validateSchedulerUpdate(_job: Job, updates: Partial<Job>, access: SchedulerJobAccess): void;
