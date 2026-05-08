import { assertSchedulerJobAccess } from './job-management-access.js';
import type {
  Job,
  JobManagementServiceDeps,
  JobRun,
  SchedulerJobAccess,
} from './job-management-types.js';
import { assertJobAppAccess } from './job-management-context-access.js';

export function createJobVisibilityReaders(input: {
  deps: JobManagementServiceDeps;
  listJobs: (scope: {
    appId?: string;
    access?: SchedulerJobAccess;
  }) => Promise<{ jobs: Job[] }>;
}) {
  const getVisibleJobForScopedRead = async (lookup: {
    jobId: string;
    appId?: string;
    access?: SchedulerJobAccess;
  }): Promise<Job | null> => {
    const job = await input.deps.ops.getJobById(lookup.jobId);
    if (!job) return null;
    if (lookup.appId) {
      await assertJobAppAccess({ deps: input.deps, job, appId: lookup.appId });
    }
    if (lookup.access) assertSchedulerJobAccess(job, lookup.access);
    return job;
  };

  const visibleJobIdsArray = async (scope: {
    appId?: string;
    access?: SchedulerJobAccess;
  }): Promise<string[] | undefined> => {
    if (!scope.appId && !scope.access) return undefined;
    const { jobs } = await input.listJobs(scope);
    return jobs.map((job) => job.id);
  };

  const filterRunsByVisibleJobs = async (
    runs: JobRun[],
    scope: { appId?: string; access?: SchedulerJobAccess },
  ): Promise<JobRun[]> => {
    const visibleJobs = new Set(await visibleJobIdsArray(scope));
    return runs.filter((run) => visibleJobs.has(run.job_id));
  };

  return {
    getVisibleJobForScopedRead,
    visibleJobIdsArray,
    filterRunsByVisibleJobs,
  };
}
