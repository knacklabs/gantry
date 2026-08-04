import { randomUUID } from 'node:crypto';

import { ApplicationError } from '../application/common/application-error.js';
import { JobManagementService } from '../application/jobs/job-management-service.js';
import type { JobScheduleType } from '../domain/types.js';
import { logger } from '../infrastructure/logging/logger.js';
import { TaskContext, TaskHandler } from './ipc-types.js';
import { createTaskResponder, toTrimmedString } from './ipc-shared.js';
import { mapApplicationError } from './ipc-application-error.js';
import { runtimeJobSchedulePlanner } from './job-schedule-planner.js';
import { invalidateSystemJobRegistrationSignature } from './system-registration-cache.js';
import { resolveRequestedJobModelPatch } from '../application/jobs/job-model-selection.js';
import { schedulerAccessFromContext } from './ipc-scheduler-access.js';
import { getSelectedAgentHarness } from '../config/index.js';
import { getRuntimeEventExchange } from '../adapters/storage/postgres/runtime-store.js';
import {
  enqueueJobTrigger,
  isJobTriggerQueueReady,
  schedulerNotReadyReason,
} from './scheduler.js';
import {
  jobSetupBlockerFromUnknown,
  setupActionLabel,
} from '../shared/job-setup-labels.js';

function makeJobService(context: TaskContext): JobManagementService {
  return new JobManagementService({
    ops: context.deps.opsRepository,
    control: context.deps.getJobControl?.(),
    scheduler: { requestSchedulerSync: context.deps.onSchedulerChanged },
    schedulePlanner: runtimeJobSchedulePlanner,
    toolRepository: context.deps.getToolRepository?.(),
    skillRepository: context.deps.getSkillRepository?.(),
    mcpServerRepository: context.deps.getMcpServerRepository?.(),
    capabilitySecretRepository: context.deps.getCapabilitySecretRepository?.(),
    getCredentialBroker: context.deps.getCredentialBroker,
    getBrowserStatus: context.deps.getBrowserStatus,
  });
}

function makeRunNowJobService(context: TaskContext): JobManagementService {
  return new JobManagementService({
    ops: context.deps.opsRepository,
    scheduler: { requestSchedulerSync: context.deps.onSchedulerChanged },
    schedulePlanner: runtimeJobSchedulePlanner,
    control: context.deps.getJobControl?.(),
    skillRepository: context.deps.getSkillRepository?.(),
    runtimeEvents: getRuntimeEventExchange(),
    triggerQueue: {
      isReady: isJobTriggerQueueReady,
      enqueue: enqueueJobTrigger,
      notReadyReason: schedulerNotReadyReason,
    },
    toolRepository: context.deps.getToolRepository?.(),
    mcpServerRepository: context.deps.getMcpServerRepository?.(),
    capabilitySecretRepository: context.deps.getCapabilitySecretRepository?.(),
    getCredentialBroker: context.deps.getCredentialBroker,
    getBrowserStatus: context.deps.getBrowserStatus,
  });
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
      const requestedModel = resolveRequestedJobModelPatch(data.modelAlias);
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
    if (data.executionContext !== undefined) {
      patch.executionContext = data.executionContext;
    }
    if (Array.isArray(data.notificationRoutes)) {
      patch.notificationRoutes = data.notificationRoutes;
    }
    if (Array.isArray(data.accessRequirements)) {
      patch.accessRequirements = data.accessRequirements;
    }
    const result = await makeJobService(context).updateJob({
      jobId,
      access: schedulerAccessFromContext(context),
      patch,
      agentHarness: getSelectedAgentHarness(sourceAgentFolder),
    });
    invalidateSystemJobRegistrationSignature(context.deps.opsRepository);
    accept(
      `Scheduler job updated (${jobId}).${formatSetupOutcome(result?.job)}`,
    );
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
    const result = await makeJobService(context).resumeJob({
      jobId,
      access: schedulerAccessFromContext(context),
      invalidSchedulePolicy: 'dead_letter',
    });
    invalidateSystemJobRegistrationSignature(context.deps.opsRepository);
    accept(
      result?.resumed !== false
        ? `Scheduler job resumed (${jobId}).`
        : `Scheduler job remains paused (${jobId}).${formatSetupOutcome(result.job)}`,
    );
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

function formatSetupOutcome(job?: { setup_state?: unknown }): string {
  const setupState = job?.setup_state;
  if (!setupState || typeof setupState !== 'object') return '';
  const state = (setupState as { state?: unknown }).state;
  if (state === 'ready') return '';
  const blockers = (setupState as { blockers?: unknown }).blockers;
  const firstBlocker = Array.isArray(blockers) ? blockers[0] : undefined;
  const action = setupActionLabel(jobSetupBlockerFromUnknown(firstBlocker));
  return ` Setup needed: ${action || String(state ?? 'unknown')}.`;
}

export const schedulerMutateTaskHandlers: Record<string, TaskHandler> = {
  scheduler_update_job: schedulerUpdateJobHandler,
  scheduler_delete_job: schedulerDeleteJobHandler,
  scheduler_pause_job: schedulerPauseJobHandler,
  scheduler_resume_job: schedulerResumeJobHandler,
  scheduler_run_now: schedulerRunNowHandler,
};
