import type { Job } from '../../domain/types.js';
import { isTrustedSystemJob } from '../../shared/system-job-identity.js';

interface SchedulerDispatchPayloadLike {
  jobId: string;
}

export const SCHEDULER_BACKGROUND_DISPATCH_PRIORITY = 0;
export const SCHEDULER_MAINTENANCE_DISPATCH_PRIORITY = -1;

export interface SchedulerDispatchWithJob<
  TPayload extends SchedulerDispatchPayloadLike,
> {
  current: Job;
  payload: TPayload;
  order: number;
}

export async function loadSchedulerDispatchesByAdmission<
  TPayload extends SchedulerDispatchPayloadLike,
>(input: {
  jobs: ReadonlyArray<{ data?: TPayload | null }>;
  getJobById: (jobId: string) => Promise<Job | null | undefined>;
}): Promise<Array<SchedulerDispatchWithJob<TPayload>>> {
  const loaded = await Promise.all(
    input.jobs.map(async (job, order) => {
      const payload = job.data;
      if (!payload?.jobId) return null;
      const current = await input.getJobById(payload.jobId);
      return current ? { current, payload, order } : null;
    }),
  );
  const dispatches: Array<SchedulerDispatchWithJob<TPayload>> = [];
  for (const dispatch of loaded) {
    if (!dispatch) continue;
    dispatches.push(dispatch);
  }
  return dispatches.sort(
    (left, right) =>
      schedulerJobAdmissionPriority(left.current) -
        schedulerJobAdmissionPriority(right.current) ||
      left.order - right.order,
  );
}

export function schedulerDeliveryPriorityForJob(
  job: Pick<Job, 'id' | 'prompt'>,
): number {
  return schedulerJobAdmissionClass(job) === 'background'
    ? SCHEDULER_BACKGROUND_DISPATCH_PRIORITY
    : SCHEDULER_MAINTENANCE_DISPATCH_PRIORITY;
}

function schedulerJobAdmissionClass(
  job: Pick<Job, 'id' | 'prompt'>,
): 'background' | 'maintenance' {
  return isTrustedSystemJob(job) ? 'maintenance' : 'background';
}

function schedulerJobAdmissionPriority(
  job: Pick<Job, 'id' | 'prompt'>,
): number {
  return schedulerJobAdmissionClass(job) === 'background' ? 0 : 1;
}
