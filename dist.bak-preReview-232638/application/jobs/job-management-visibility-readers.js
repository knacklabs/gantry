import { assertSchedulerJobAccess } from './job-management-access.js';
import { assertJobAppAccess } from './job-management-context-access.js';
export function createJobVisibilityReaders(input) {
    const getVisibleJobForScopedRead = async (lookup) => {
        const job = await input.deps.ops.getJobById(lookup.jobId);
        if (!job)
            return null;
        if (lookup.appId) {
            await assertJobAppAccess({ deps: input.deps, job, appId: lookup.appId });
        }
        if (lookup.access)
            assertSchedulerJobAccess(job, lookup.access);
        return job;
    };
    const visibleJobIdsArray = async (scope) => {
        if (!scope.appId && !scope.access)
            return undefined;
        const { jobs } = await input.listJobs(scope);
        return jobs.map((job) => job.id);
    };
    const filterRunsByVisibleJobs = async (runs, scope) => {
        const visibleJobs = new Set(await visibleJobIdsArray(scope));
        return runs.filter((run) => visibleJobs.has(run.job_id));
    };
    return {
        getVisibleJobForScopedRead,
        visibleJobIdsArray,
        filterRunsByVisibleJobs,
    };
}
