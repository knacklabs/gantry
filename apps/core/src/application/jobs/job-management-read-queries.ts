import { resolveLimit } from './job-management-helpers.js';
import { ApplicationError } from '../common/application-error.js';
import { parseRuntimeEventType } from '../../domain/events/runtime-event-types.js';
import type {
  Job,
  JobEvent,
  JobManagementServiceDeps,
  JobRun,
  SchedulerJobAccess,
} from './job-management-types.js';

const DEFAULT_RUN_LIMIT = 50;
const DEFAULT_EVENT_LIMIT = 200;
const DEFAULT_DEAD_LETTER_LIMIT = 50;

type ScopedVisibilityInput = {
  appId?: string;
  access?: SchedulerJobAccess;
};

type ScopedReadJobLookup = ScopedVisibilityInput & {
  jobId: string;
};

interface JobVisibilityReaders {
  getVisibleJobForScopedRead(input: ScopedReadJobLookup): Promise<Job | null>;
  visibleJobIdsArray(
    input: ScopedVisibilityInput,
  ): Promise<string[] | undefined>;
  filterRunsByVisibleJobs(
    runs: JobRun[],
    input: ScopedVisibilityInput,
  ): Promise<JobRun[]>;
}

export async function listManagedJobRuns(input: {
  deps: JobManagementServiceDeps;
  visibility: JobVisibilityReaders;
  appId?: string;
  access?: SchedulerJobAccess;
  jobId?: string;
  limit?: number;
}): Promise<{ runs: JobRun[] }> {
  if (input.jobId) {
    const job = await input.visibility.getVisibleJobForScopedRead({
      jobId: input.jobId,
      appId: input.appId,
      access: input.access,
    });
    if (!job) return { runs: [] };
  }
  const ownerAppId =
    !input.jobId && input.appId && !input.access ? input.appId : undefined;
  const visibleJobIds =
    input.jobId || ownerAppId
      ? undefined
      : await input.visibility.visibleJobIdsArray({
          appId: input.appId,
          access: input.access,
        });
  if (visibleJobIds?.length === 0) return { runs: [] };
  const runs = await input.deps.ops.listJobRuns(
    input.jobId,
    resolveLimit(input.limit, DEFAULT_RUN_LIMIT),
    input.jobId ? undefined : { jobIds: visibleJobIds, ownerAppId },
  );
  return { runs };
}

export async function listManagedJobEvents(input: {
  deps: JobManagementServiceDeps;
  visibility: JobVisibilityReaders;
  appId?: string;
  access?: SchedulerJobAccess;
  jobId?: string;
  runId?: string;
  eventType?: string;
  sinceId?: number;
  since?: string;
  limit?: number;
}): Promise<{ events: JobEvent[] }> {
  const eventType =
    input.eventType === undefined
      ? undefined
      : parseRuntimeEventType(input.eventType);
  if (input.eventType !== undefined && !eventType) {
    throw new ApplicationError(
      'INVALID_REQUEST',
      `Unknown runtime event type "${input.eventType}".`,
    );
  }
  if (input.jobId) {
    const job = await input.visibility.getVisibleJobForScopedRead({
      jobId: input.jobId,
      appId: input.appId,
      access: input.access,
    });
    if (!job) return { events: [] };
  }
  const ownerAppId =
    !input.jobId && input.appId && !input.access ? input.appId : undefined;
  const visibleJobIds =
    input.jobId || ownerAppId
      ? undefined
      : await input.visibility.visibleJobIdsArray({
          appId: input.appId,
          access: input.access,
        });
  if (visibleJobIds?.length === 0) return { events: [] };
  const events = await input.deps.ops.listRecentJobEvents(
    resolveLimit(input.limit, DEFAULT_EVENT_LIMIT),
    {
      app_id:
        input.jobId || visibleJobIds || ownerAppId ? undefined : input.appId,
      owner_app_id: ownerAppId,
      job_id: input.jobId,
      job_ids: visibleJobIds,
      run_id: input.runId,
      event_type: eventType,
      since_id: input.sinceId,
      since: input.since,
    },
  );
  return { events };
}

export async function listManagedDeadLetterRuns(input: {
  deps: JobManagementServiceDeps;
  visibility: JobVisibilityReaders;
  appId?: string;
  access?: SchedulerJobAccess;
  limit?: number;
}): Promise<{ deadLetterRuns: JobRun[] }> {
  const runs = await input.deps.ops.listDeadLetterRuns(
    resolveLimit(input.limit, DEFAULT_DEAD_LETTER_LIMIT),
  );
  if (!input.appId && !input.access) return { deadLetterRuns: runs };
  const visible = await input.visibility.filterRunsByVisibleJobs(runs, {
    appId: input.appId,
    access: input.access,
  });
  return { deadLetterRuns: visible };
}
