import { JobManagementService } from '../application/jobs/job-management-service.js';
import {
  buildJobListVisibilityMetadata,
  buildJobVisibilityMetadata,
} from '../application/jobs/job-visibility-metadata.js';
import { logger } from '../infrastructure/logging/logger.js';
import { TaskContext, TaskHandler } from './ipc-types.js';
import { mapApplicationError } from './ipc-application-error.js';
import { createTaskResponder, toTrimmedString } from './ipc-shared.js';
import { schedulerAccessFromContext } from './ipc-scheduler-access.js';
import { runtimeJobSchedulePlanner } from './job-schedule-planner.js';

function makeJobService(context: TaskContext): JobManagementService {
  return new JobManagementService({
    ops: context.deps.opsRepository,
    scheduler: { requestSchedulerSync: context.deps.onSchedulerChanged },
    schedulePlanner: runtimeJobSchedulePlanner,
    toolRepository: context.deps.getToolRepository?.(),
  });
}

const schedulerGetJobHandler: TaskHandler = async (context) => {
  const { data, sourceGroup } = context;
  const { acceptData, reject } = createTaskResponder(
    sourceGroup,
    data.taskId,
    data.authThreadId,
  );
  const jobId = toTrimmedString(data.jobId, { maxLen: 128 });
  if (!jobId) {
    reject('scheduler_get_job requires jobId.', 'invalid_request');
    return;
  }
  try {
    const service = makeJobService(context);
    const result = await service.getJob({
      jobId,
      access: schedulerAccessFromContext(context),
    });
    const data = result.job
      ? {
          job: {
            ...result.job,
            visibility: await buildJobVisibilityMetadata({
              job: result.job,
              ops: context.deps.opsRepository,
              toolRepository: context.deps.getToolRepository?.(),
            }),
          },
        }
      : result;
    acceptData(
      result.job ? `Loaded scheduler job (${jobId}).` : 'Job not found.',
      data,
    );
  } catch (err) {
    const mapped = mapApplicationError(err, 'Failed to query scheduler jobs.');
    logger.error({ err, sourceGroup, jobId }, 'scheduler_get_job failed');
    reject(mapped.message, mapped.code);
  }
};

const schedulerListJobsHandler: TaskHandler = async (context) => {
  const { data, sourceGroup } = context;
  const { acceptData, reject } = createTaskResponder(
    sourceGroup,
    data.taskId,
    data.authThreadId,
  );
  try {
    const service = makeJobService(context);
    const result = await service.listJobs({
      access: schedulerAccessFromContext(context),
      statuses: Array.isArray(data.statuses) ? data.statuses : undefined,
      kind:
        data.kind === 'manual' ||
        data.kind === 'once' ||
        data.kind === 'recurring'
          ? data.kind
          : undefined,
      limit: data.limit,
    });
    const metadata = await buildJobListVisibilityMetadata({
      jobs: result.jobs,
      toolRepository: context.deps.getToolRepository?.(),
    });
    acceptData(`Listed ${result.jobs.length} scheduler job(s).`, {
      jobs: result.jobs.map(({ prompt: _prompt, ...job }) => ({
        ...job,
        prompt_preview: metadata.get(job.id)?.promptPreview,
        visibility: metadata.get(job.id),
      })),
    });
  } catch (err) {
    const mapped = mapApplicationError(err, 'Failed to query scheduler jobs.');
    logger.error({ err, sourceGroup }, 'scheduler_list_jobs failed');
    reject(mapped.message, mapped.code);
  }
};

const schedulerListRunsHandler: TaskHandler = async (context) => {
  const { data, sourceGroup } = context;
  const { acceptData, reject } = createTaskResponder(
    sourceGroup,
    data.taskId,
    data.authThreadId,
  );
  const jobId = toTrimmedString(data.jobId, { maxLen: 128 });
  try {
    const result = await makeJobService(context).listJobRuns({
      access: schedulerAccessFromContext(context),
      jobId: jobId || undefined,
      limit: data.limit,
    });
    acceptData(`Listed ${result.runs.length} scheduler run(s).`, result);
  } catch (err) {
    const mapped = mapApplicationError(err, 'Failed to query scheduler jobs.');
    logger.error(
      { err, sourceGroup, jobId: jobId || undefined },
      'scheduler_list_runs failed unexpectedly',
    );
    reject(mapped.message, mapped.code);
  }
};

const schedulerListEventsHandler: TaskHandler = async (context) => {
  const { data, sourceGroup } = context;
  const { acceptData, reject } = createTaskResponder(
    sourceGroup,
    data.taskId,
    data.authThreadId,
  );
  const jobId = toTrimmedString(data.jobId, { maxLen: 128 });
  const runId = toTrimmedString(data.runId, { maxLen: 128 });
  const eventType = toTrimmedString(data.eventType, { maxLen: 128 });
  try {
    const result = await makeJobService(context).listJobEvents({
      access: schedulerAccessFromContext(context),
      jobId: jobId || undefined,
      runId: runId || undefined,
      eventType: eventType || undefined,
      since: toTrimmedString(data.since, { maxLen: 128 }) || undefined,
      sinceId:
        typeof data.sinceId === 'number' && Number.isFinite(data.sinceId)
          ? Math.max(0, Math.floor(data.sinceId))
          : undefined,
      limit: data.limit,
    });
    acceptData(`Listed ${result.events.length} scheduler event(s).`, result);
  } catch (err) {
    const mapped = mapApplicationError(err, 'Failed to query scheduler jobs.');
    logger.error(
      {
        err,
        sourceGroup,
        jobId: jobId || undefined,
        runId: runId || undefined,
        eventType: eventType || undefined,
      },
      'scheduler_list_events failed unexpectedly',
    );
    reject(mapped.message, mapped.code);
  }
};

const schedulerGetDeadLetterHandler: TaskHandler = async (context) => {
  const { data, sourceGroup } = context;
  const { acceptData, reject } = createTaskResponder(
    sourceGroup,
    data.taskId,
    data.authThreadId,
  );
  try {
    const result = await makeJobService(context).listDeadLetterRuns({
      access: schedulerAccessFromContext(context),
      limit: data.limit,
    });
    acceptData(
      `Listed ${result.deadLetterRuns.length} dead-letter run(s).`,
      result,
    );
  } catch (err) {
    const mapped = mapApplicationError(err, 'Failed to query scheduler jobs.');
    logger.error({ err, sourceGroup }, 'scheduler_get_dead_letter failed');
    reject(mapped.message, mapped.code);
  }
};

export const schedulerQueryTaskHandlers: Record<string, TaskHandler> = {
  scheduler_get_job: schedulerGetJobHandler,
  scheduler_list_jobs: schedulerListJobsHandler,
  scheduler_list_runs: schedulerListRunsHandler,
  scheduler_list_events: schedulerListEventsHandler,
  scheduler_wait_for_events: schedulerListEventsHandler,
  scheduler_get_dead_letter: schedulerGetDeadLetterHandler,
};
