import { randomUUID } from 'node:crypto';

import { ApplicationError } from '../application/common/application-error.js';
import { JobManagementService } from '../application/jobs/job-management-service.js';
import type { JobExtraToolApprovalRequest } from '../application/jobs/job-management-types.js';
import type { JobExecutionMode, JobScheduleType } from '../domain/types.js';
import { logger } from '../infrastructure/logging/logger.js';
import { TaskContext, TaskHandler } from './ipc-types.js';
import {
  createTaskResponder,
  normalizeIpcExecutionMode,
  toTrimmedString,
} from './ipc-shared.js';
import { mapApplicationError } from './ipc-application-error.js';
import { runtimeJobSchedulePlanner } from './job-schedule-planner.js';
import { invalidateSystemJobRegistrationSignature } from './system-registration-cache.js';
import { resolveRequestedJobModelPatch } from '../application/jobs/job-model-selection.js';
import { resolveSchedulerApprovalTarget } from './ipc-scheduler-approval-target.js';
import { schedulerAccessFromContext } from './ipc-scheduler-access.js';
import { getRuntimeEventExchange } from '../adapters/storage/postgres/runtime-store.js';
import { enqueueJobTrigger, isSchedulerReady } from './scheduler.js';

function makeJobService(context: TaskContext): JobManagementService {
  return new JobManagementService({
    ops: context.deps.opsRepository,
    control: context.deps.getJobControl?.(),
    scheduler: { requestSchedulerSync: context.deps.onSchedulerChanged },
    schedulePlanner: runtimeJobSchedulePlanner,
    toolRepository: context.deps.getToolRepository?.(),
    approveJobExtraTools: (request) =>
      requestJobExtraToolApproval(context, request),
  });
}

function makeRunNowJobService(context: TaskContext): JobManagementService {
  return new JobManagementService({
    ops: context.deps.opsRepository,
    scheduler: { requestSchedulerSync: context.deps.onSchedulerChanged },
    schedulePlanner: runtimeJobSchedulePlanner,
    toolRepository: context.deps.getToolRepository?.(),
    control: context.deps.getJobControl?.(),
    runtimeEvents: getRuntimeEventExchange(),
    triggerQueue: {
      isReady: isSchedulerReady,
      enqueue: enqueueJobTrigger,
    },
  });
}

async function requestJobExtraToolApproval(
  context: TaskContext,
  request: JobExtraToolApprovalRequest,
): Promise<{ approved: boolean; reason?: string }> {
  const approvalTarget = resolveSchedulerApprovalTarget(context);
  if (!approvalTarget.ok) {
    return { approved: false, reason: approvalTarget.reason };
  }
  const decision = await context.deps.requestPermissionApproval({
    requestId: `job-tools-${randomUUID()}`,
    appId: request.target.appId as never,
    agentId: request.target.agentId as never,
    sourceAgentFolder: context.sourceAgentFolder,
    targetJid: approvalTarget.targetJid,
    threadId: context.data.authThreadId,
    decisionPolicy: 'same_channel',
    toolName: 'scheduler_job_tools',
    displayName: 'Autonomous job tools',
    title: 'Approve job-scoped autonomous tools',
    description:
      'stored on this job only; inherited agent grants are shown separately.',
    decisionReason: `Update scheduler job ${request.jobName} with job-scoped extra tools.`,
    toolInput: {
      jobId: request.jobId,
      target: request.target,
      inheritedTools: request.inheritedTools,
      existingJobExtraTools: request.existingJobExtraTools,
      requestedJobExtraTools: request.requestedJobExtraTools,
      extrasBeyondInherited: request.extrasBeyondInherited,
      persistence: 'target_json.capabilityPolicy.allowedTools',
    },
    decisionOptions: ['allow_job_policy', 'cancel'],
  });
  return { approved: decision.approved, reason: decision.reason };
}

function scheduleType(raw: unknown): JobScheduleType | undefined {
  return raw === 'cron' || raw === 'interval' || raw === 'once'
    ? raw
    : undefined;
}

async function resumeDeadLetterDetails(
  context: TaskContext,
  jobId: string,
  err: unknown,
): Promise<string[] | undefined> {
  if (!(err instanceof ApplicationError) || err.code !== 'INVALID_SCHEDULE') {
    return undefined;
  }
  try {
    const job = await context.deps.opsRepository.getJobById(jobId);
    if (job?.status !== 'dead_lettered') return undefined;
    const pauseReason =
      typeof job?.pause_reason === 'string' ? job.pause_reason.trim() : '';
    if (!pauseReason) return undefined;
    return [pauseReason, 'Job has been moved to dead_lettered state.'];
  } catch (lookupErr) {
    logger.warn(
      { err: lookupErr, sourceAgentFolder: context.sourceAgentFolder, jobId },
      'Failed to read dead-lettered job details after scheduler_resume_job failure',
    );
    return undefined;
  }
}

const schedulerUpdateJobHandler: TaskHandler = async (context) => {
  const { data, sourceAgentFolder } = context;
  const { accept, reject } = createTaskResponder(
    sourceAgentFolder,
    data.taskId,
    data.authThreadId,
    data.responseKeyId,
  );
  const jobId = toTrimmedString(data.jobId, { maxLen: 128 });
  if (!jobId) {
    reject('scheduler_update_job requires jobId.', 'invalid_request');
    return;
  }
  try {
    const patch: Parameters<JobManagementService['updateJob']>[0]['patch'] = {};
    if (data.name !== undefined) patch.name = data.name;
    if (data.prompt !== undefined) patch.prompt = data.prompt;
    try {
      const requestedModel = resolveRequestedJobModelPatch(
        data.modelAlias,
        data.modelProfileId,
      );
      if (requestedModel.specified) {
        patch.model = requestedModel.model;
      }
    } catch (err) {
      if (err instanceof ApplicationError) {
        reject(err.message, 'invalid_model');
        return;
      }
      throw err;
    }
    if (data.scheduleType !== undefined) {
      const normalized = scheduleType(data.scheduleType);
      if (!normalized) {
        reject('Unsupported schedule type.', 'invalid_schedule');
        return;
      }
      patch.scheduleType = normalized;
    }
    if (data.scheduleValue !== undefined)
      patch.scheduleValue = data.scheduleValue;
    if (data.timeoutMs !== undefined) patch.timeoutMs = data.timeoutMs;
    if (data.maxRetries !== undefined) patch.maxRetries = data.maxRetries;
    if (data.retryBackoffMs !== undefined) {
      patch.retryBackoffMs = data.retryBackoffMs;
    }
    if (data.maxConsecutiveFailures !== undefined) {
      patch.maxConsecutiveFailures = data.maxConsecutiveFailures;
    }
    if (data.silent !== undefined) patch.silent = data.silent;
    if (data.cleanupAfterMs !== undefined) {
      patch.cleanupAfterMs = data.cleanupAfterMs;
    }
    if (data.executionMode !== undefined || data.serialize !== undefined) {
      patch.executionMode = normalizeIpcExecutionMode(
        data.executionMode,
        data.serialize,
      ) as JobExecutionMode;
    }
    if (data.executionContext !== undefined) {
      patch.executionContext = data.executionContext;
    }
    if (Array.isArray(data.notificationRoutes)) {
      patch.notificationRoutes = data.notificationRoutes;
    }
    if (Array.isArray(data.allowedTools)) {
      patch.allowedTools = data.allowedTools.map((item) => String(item));
    }

    await makeJobService(context).updateJob({
      jobId,
      access: schedulerAccessFromContext(context),
      patch,
    });
    invalidateSystemJobRegistrationSignature(context.deps.opsRepository);
    accept(`Scheduler job updated (${jobId}).`);
  } catch (err) {
    const mapped = mapApplicationError(err, 'Failed to mutate scheduler job.');
    logger.error(
      { err, sourceAgentFolder, jobId },
      'scheduler_update_job failed unexpectedly',
    );
    reject(mapped.message, mapped.code);
  }
};

const schedulerDeleteJobHandler: TaskHandler = async (context) => {
  const { data, sourceAgentFolder } = context;
  const { accept, reject } = createTaskResponder(
    sourceAgentFolder,
    data.taskId,
    data.authThreadId,
    data.responseKeyId,
  );
  const jobId = toTrimmedString(data.jobId, { maxLen: 128 });
  if (!jobId) {
    reject('scheduler_delete_job requires jobId.', 'invalid_request');
    return;
  }
  try {
    await makeJobService(context).deleteJob({
      jobId,
      access: schedulerAccessFromContext(context),
    });
    invalidateSystemJobRegistrationSignature(context.deps.opsRepository);
    accept(`Scheduler job deleted (${jobId}).`);
  } catch (err) {
    const mapped = mapApplicationError(err, 'Failed to mutate scheduler job.');
    logger.error(
      { err, sourceAgentFolder, jobId },
      'scheduler_delete_job failed unexpectedly',
    );
    reject(mapped.message, mapped.code);
  }
};

const schedulerPauseJobHandler: TaskHandler = async (context) => {
  const { data, sourceAgentFolder } = context;
  const { accept, reject } = createTaskResponder(
    sourceAgentFolder,
    data.taskId,
    data.authThreadId,
    data.responseKeyId,
  );
  const jobId = toTrimmedString(data.jobId, { maxLen: 128 });
  if (!jobId) {
    reject('scheduler_pause_job requires jobId.', 'invalid_request');
    return;
  }
  try {
    await makeJobService(context).pauseJob({
      jobId,
      access: schedulerAccessFromContext(context),
      reason: 'Paused by user',
    });
    invalidateSystemJobRegistrationSignature(context.deps.opsRepository);
    accept(`Scheduler job paused (${jobId}).`);
  } catch (err) {
    const mapped = mapApplicationError(err, 'Failed to mutate scheduler job.');
    logger.error(
      { err, sourceAgentFolder, jobId },
      'scheduler_pause_job failed unexpectedly',
    );
    reject(mapped.message, mapped.code);
  }
};

const schedulerResumeJobHandler: TaskHandler = async (context) => {
  const { data, sourceAgentFolder } = context;
  const { accept, reject } = createTaskResponder(
    sourceAgentFolder,
    data.taskId,
    data.authThreadId,
    data.responseKeyId,
  );
  const jobId = toTrimmedString(data.jobId, { maxLen: 128 });
  if (!jobId) {
    reject('scheduler_resume_job requires jobId.', 'invalid_request');
    return;
  }
  try {
    await makeJobService(context).resumeJob({
      jobId,
      access: schedulerAccessFromContext(context),
      invalidSchedulePolicy: 'dead_letter',
    });
    invalidateSystemJobRegistrationSignature(context.deps.opsRepository);
    accept(`Scheduler job resumed (${jobId}).`);
  } catch (err) {
    const mapped = mapApplicationError(err, 'Failed to mutate scheduler job.');
    const details = await resumeDeadLetterDetails(context, jobId, err);
    logger.error(
      { err, sourceAgentFolder, jobId },
      'scheduler_resume_job failed unexpectedly',
    );
    reject(mapped.message, mapped.code, details);
  }
};

const schedulerRunNowHandler: TaskHandler = async (context) => {
  const { data, sourceAgentFolder } = context;
  const { acceptData, reject } = createTaskResponder(
    sourceAgentFolder,
    data.taskId,
    data.authThreadId,
    data.responseKeyId,
  );
  const jobId = toTrimmedString(data.jobId, { maxLen: 128 });
  if (!jobId) {
    reject('scheduler_run_now requires jobId.', 'invalid_request');
    return;
  }
  const runId = randomUUID();
  try {
    const result = await makeRunNowJobService(context).runJobNowFromMcp({
      jobId,
      access: schedulerAccessFromContext(context),
      runId,
    });
    acceptData(`Scheduler job queued (${jobId}).`, {
      run_id: result.runId,
      queued: result.queued,
      trigger_id: result.triggerId,
    });
  } catch (err) {
    const mapped = mapApplicationError(err, 'Failed to run scheduler job.');
    logger.error(
      { err, sourceAgentFolder, jobId },
      'scheduler_run_now failed unexpectedly',
    );
    reject(mapped.message, mapped.code);
  }
};

export const schedulerMutateTaskHandlers: Record<string, TaskHandler> = {
  scheduler_update_job: schedulerUpdateJobHandler,
  scheduler_delete_job: schedulerDeleteJobHandler,
  scheduler_pause_job: schedulerPauseJobHandler,
  scheduler_resume_job: schedulerResumeJobHandler,
  scheduler_run_now: schedulerRunNowHandler,
};
