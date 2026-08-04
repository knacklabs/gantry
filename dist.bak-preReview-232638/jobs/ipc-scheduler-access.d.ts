import type { SchedulerJobAccess } from '../application/jobs/job-management-types.js';
import type { TaskContext } from './ipc-types.js';
export declare function schedulerAccessFromContext(context: TaskContext): SchedulerJobAccess;
