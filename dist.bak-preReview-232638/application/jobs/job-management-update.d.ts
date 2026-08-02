import type { Clock } from '../common/clock.js';
import type { Job, JobManagementServiceDeps, ManagedJobUpdateInput } from './job-management-types.js';
export declare function updateManagedJob(deps: JobManagementServiceDeps, input: ManagedJobUpdateInput, clock: Clock): Promise<{
    job: Job;
}>;
