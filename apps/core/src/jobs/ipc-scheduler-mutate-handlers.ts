import { ApplicationError } from '../application/common/application-error.js';
import { JobManagementService } from '../application/jobs/job-management-service.js';
import type { JobExecutionMode, JobScheduleType } from '../domain/types.js';
import { logger } from '../infrastructure/logging/logger.js';
import { TaskContext, TaskHandler } from './ipc-types.js';
import {
  createTaskResponder,
  normalizeIpcExecutionMode,
  toTrimmedString,
} from './ipc-shared.js';
import { runtimeJobSchedulePlanner } from './job-schedule-planner.js';
import { invalidateSystemJobRegistrationSignature } from './system-registration-cache.js';

function makeJobService(context: TaskContext): JobManagementService {
  return new JobManagementService({
    ops: context.deps.opsRepository,
    scheduler: { requestSchedulerSync: context.deps.onSchedulerChanged },
    schedulePlanner: runtimeJobSchedulePlanner,
  });
}

function accessFromContext(context: TaskContext) {
  return {
    sourceGroup: context.sourceGroup,
    isMain: context.isMain,
    conversationBindings: context.registeredGroups,
    sourceGroupJids: context.sourceGroupJids,
    authThreadId: context.data.authThreadId,
  };
}

function mapApplicationError(error: unknown): {
  message: string;
  code: string;
} {
  if (error instanceof ApplicationError) {
    return {
      message: error.message,
      code:
        error.code === 'NOT_FOUND'
          ? 'not_found'
          : error.code === 'FORBIDDEN'
            ? 'forbidden'
            : error.code === 'INVALID_REQUEST'
              ? 'invalid_request'
              : error.code === 'UNAVAILABLE'
                ? 'unavailable'
                : 'internal_error',
    };
  }
  return {
    message:
      error instanceof Error
        ? error.message
        : 'Failed to mutate scheduler job.',
    code: 'internal_error',
  };
}

function scheduleType(raw: unknown): JobScheduleType | undefined {
  return raw === 'cron' || raw === 'interval' || raw === 'once'
    ? raw
    : undefined;
}

const schedulerUpdateJobHandler: TaskHandler = async (context) => {
  const { data, sourceGroup } = context;
  const { accept, reject } = createTaskResponder(
    sourceGroup,
    data.taskId,
    data.authThreadId,
  );
  const jobId = toTrimmedString(data.jobId, { maxLen: 128 });
  if (!jobId) {
    reject('scheduler_update_job requires jobId.', 'invalid_request');
    return;
  }
  if (data.script !== undefined) {
    logger.warn(
      { sourceGroup, jobId },
      'Rejected scheduler_update_job script mutation from IPC',
    );
    reject(
      'script mutation is not allowed for scheduler_update_job.',
      'forbidden',
    );
    return;
  }

  try {
    const patch: Parameters<JobManagementService['updateJob']>[0]['patch'] = {};
    if (data.name !== undefined) patch.name = data.name;
    if (data.prompt !== undefined) patch.prompt = data.prompt;
    if (data.model !== undefined) patch.model = data.model;
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
    if (data.groupScope !== undefined) patch.groupScope = data.groupScope;
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
    if (data.threadId !== undefined) {
      patch.threadId =
        typeof data.threadId === 'string' && data.threadId.trim()
          ? data.threadId.trim()
          : null;
    }
    if (Array.isArray(data.linkedSessions) || Array.isArray(data.deliverTo)) {
      patch.linkedSessions = (
        Array.isArray(data.deliverTo)
          ? data.deliverTo
          : data.linkedSessions || []
      ).map((item) => String(item));
    }

    await makeJobService(context).updateJob({
      jobId,
      access: accessFromContext(context),
      patch,
    });
    invalidateSystemJobRegistrationSignature(context.deps.opsRepository);
    accept(`Scheduler job updated (${jobId}).`);
  } catch (err) {
    const mapped = mapApplicationError(err);
    logger.error(
      { err, sourceGroup, jobId },
      'scheduler_update_job failed unexpectedly',
    );
    reject(mapped.message, mapped.code);
  }
};

const schedulerDeleteJobHandler: TaskHandler = async (context) => {
  const { data, sourceGroup } = context;
  const { accept, reject } = createTaskResponder(
    sourceGroup,
    data.taskId,
    data.authThreadId,
  );
  const jobId = toTrimmedString(data.jobId, { maxLen: 128 });
  if (!jobId) {
    reject('scheduler_delete_job requires jobId.', 'invalid_request');
    return;
  }
  try {
    await makeJobService(context).deleteJob({
      jobId,
      access: accessFromContext(context),
    });
    invalidateSystemJobRegistrationSignature(context.deps.opsRepository);
    accept(`Scheduler job deleted (${jobId}).`);
  } catch (err) {
    const mapped = mapApplicationError(err);
    logger.error(
      { err, sourceGroup, jobId },
      'scheduler_delete_job failed unexpectedly',
    );
    reject(mapped.message, mapped.code);
  }
};

const schedulerPauseJobHandler: TaskHandler = async (context) => {
  const { data, sourceGroup } = context;
  const { accept, reject } = createTaskResponder(
    sourceGroup,
    data.taskId,
    data.authThreadId,
  );
  const jobId = toTrimmedString(data.jobId, { maxLen: 128 });
  if (!jobId) {
    reject('scheduler_pause_job requires jobId.', 'invalid_request');
    return;
  }
  try {
    await makeJobService(context).pauseJob({
      jobId,
      access: accessFromContext(context),
      reason: 'Paused by user',
    });
    invalidateSystemJobRegistrationSignature(context.deps.opsRepository);
    accept(`Scheduler job paused (${jobId}).`);
  } catch (err) {
    const mapped = mapApplicationError(err);
    logger.error(
      { err, sourceGroup, jobId },
      'scheduler_pause_job failed unexpectedly',
    );
    reject(mapped.message, mapped.code);
  }
};

const schedulerResumeJobHandler: TaskHandler = async (context) => {
  const { data, sourceGroup } = context;
  const { accept, reject } = createTaskResponder(
    sourceGroup,
    data.taskId,
    data.authThreadId,
  );
  const jobId = toTrimmedString(data.jobId, { maxLen: 128 });
  if (!jobId) {
    reject('scheduler_resume_job requires jobId.', 'invalid_request');
    return;
  }
  try {
    await makeJobService(context).resumeJob({
      jobId,
      access: accessFromContext(context),
    });
    invalidateSystemJobRegistrationSignature(context.deps.opsRepository);
    accept(`Scheduler job resumed (${jobId}).`);
  } catch (err) {
    const mapped = mapApplicationError(err);
    logger.error(
      { err, sourceGroup, jobId },
      'scheduler_resume_job failed unexpectedly',
    );
    reject(mapped.message, mapped.code);
  }
};

export const schedulerMutateTaskHandlers: Record<string, TaskHandler> = {
  scheduler_update_job: schedulerUpdateJobHandler,
  scheduler_delete_job: schedulerDeleteJobHandler,
  scheduler_pause_job: schedulerPauseJobHandler,
  scheduler_resume_job: schedulerResumeJobHandler,
};
