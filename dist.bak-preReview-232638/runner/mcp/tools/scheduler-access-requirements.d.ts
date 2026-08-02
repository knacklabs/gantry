import type { SchedulerJobPlanInput } from '../../../shared/scheduler-job-plan.js';
import type { SchedulerAccessRequirementInput } from './scheduler-capability-schema.js';
export declare function normalizeSchedulerAccessRequirements(input: SchedulerAccessRequirementInput[] | undefined): SchedulerJobPlanInput['accessRequirements'];
