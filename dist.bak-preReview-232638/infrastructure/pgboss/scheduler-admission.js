import { isTrustedSystemJob } from '../../shared/system-job-identity.js';
export const SCHEDULER_BACKGROUND_DISPATCH_PRIORITY = 0;
export const SCHEDULER_MAINTENANCE_DISPATCH_PRIORITY = -1;
export async function loadSchedulerDispatchesByAdmission(input) {
    const loaded = await Promise.all(input.jobs.map(async (job, order) => {
        const payload = job.data;
        if (!payload?.jobId)
            return null;
        const current = await input.getJobById(payload.jobId);
        return current ? { current, payload, order } : null;
    }));
    const dispatches = [];
    for (const dispatch of loaded) {
        if (!dispatch)
            continue;
        dispatches.push(dispatch);
    }
    return dispatches.sort((left, right) => schedulerJobAdmissionPriority(left.current) -
        schedulerJobAdmissionPriority(right.current) ||
        left.order - right.order);
}
export function schedulerDeliveryPriorityForJob(job) {
    return schedulerJobAdmissionClass(job) === 'background'
        ? SCHEDULER_BACKGROUND_DISPATCH_PRIORITY
        : SCHEDULER_MAINTENANCE_DISPATCH_PRIORITY;
}
function schedulerJobAdmissionClass(job) {
    return isTrustedSystemJob(job) ? 'maintenance' : 'background';
}
function schedulerJobAdmissionPriority(job) {
    return schedulerJobAdmissionClass(job) === 'background' ? 0 : 1;
}
