import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from '../core/config.js';
import { logger } from '../core/logger.js';
import { deleteJob, getJobById, updateJob } from '../storage/db.js';
import { TaskHandler } from './ipc-task-types.js';
import {
  jobBelongsToSourceGroup,
  normalizeIpcExecutionMode,
} from './ipc-task-shared.js';

const schedulerUpdateJobHandler: TaskHandler = (context) => {
  const { data, sourceGroup, isMain, deps, registeredGroups } = context;
  const jobId = (data.jobId || data.taskId || '').toString();
  if (!jobId) return;
  const job = getJobById(jobId);
  if (!job) return;
  if (!isMain && !jobBelongsToSourceGroup(job, sourceGroup, registeredGroups)) {
    logger.warn(
      {
        sourceGroup,
        groupScope: job.group_scope,
        linkedSessions: job.linked_sessions,
        jobId,
      },
      'Unauthorized scheduler_update_job attempt blocked',
    );
    return;
  }

  const updates: Parameters<typeof updateJob>[1] = {};
  if (data.name !== undefined) updates.name = data.name;
  if (data.prompt !== undefined) updates.prompt = data.prompt;
  if (data.model !== undefined) updates.model = data.model;
  if (data.script !== undefined) {
    logger.warn(
      { sourceGroup, jobId },
      'Rejected scheduler_update_job script mutation from IPC',
    );
    return;
  }
  if (data.schedule_type !== undefined) {
    updates.schedule_type = data.schedule_type as
      | 'cron'
      | 'interval'
      | 'once'
      | 'manual';
  }
  if (data.schedule_value !== undefined)
    updates.schedule_value = data.schedule_value;
  if (data.groupScope !== undefined) {
    if (!isMain && data.groupScope !== sourceGroup) {
      logger.warn(
        { sourceGroup, requestedGroupScope: data.groupScope, jobId },
        'Unauthorized group scope mutation in scheduler_update_job',
      );
      return;
    }
    updates.group_scope = data.groupScope;
  }
  if (typeof data.timeoutMs === 'number') updates.timeout_ms = data.timeoutMs;
  if (typeof data.maxRetries === 'number')
    updates.max_retries = data.maxRetries;
  if (typeof data.retryBackoffMs === 'number') {
    updates.retry_backoff_ms = data.retryBackoffMs;
  }
  if (typeof data.maxConsecutiveFailures === 'number') {
    updates.max_consecutive_failures = data.maxConsecutiveFailures;
  }
  if (typeof data.silent === 'boolean') updates.silent = data.silent;
  if (typeof data.cleanupAfterMs === 'number') {
    updates.cleanup_after_ms = data.cleanupAfterMs;
  }
  if (data.executionMode !== undefined || data.serialize !== undefined) {
    updates.execution_mode = normalizeIpcExecutionMode(
      data.executionMode,
      data.serialize,
      job.execution_mode,
    );
  }
  if (data.threadId !== undefined) updates.thread_id = data.threadId || null;
  if (Array.isArray(data.linkedSessions) || Array.isArray(data.deliverTo)) {
    const source = Array.isArray(data.deliverTo)
      ? data.deliverTo
      : data.linkedSessions || [];
    const linked = source.map((item) => String(item));
    if (!isMain) {
      const unauthorized = linked.some((jid) => {
        const group = registeredGroups[jid];
        return !group || group.folder !== sourceGroup;
      });
      if (unauthorized) {
        logger.warn(
          { sourceGroup, linked },
          'Unauthorized linked sessions in scheduler_update_job',
        );
        return;
      }
    }
    updates.linked_sessions = linked;
  }

  const merged = { ...job, ...updates };
  if (
    updates.schedule_type !== undefined ||
    updates.schedule_value !== undefined
  ) {
    if (merged.schedule_type === 'cron') {
      try {
        const interval = CronExpressionParser.parse(merged.schedule_value, {
          tz: TIMEZONE,
        });
        updates.next_run = interval.next().toISOString();
      } catch {
        logger.warn(
          { jobId, value: merged.schedule_value },
          'Invalid cron in scheduler_update_job',
        );
        return;
      }
    } else if (merged.schedule_type === 'interval') {
      const ms = parseInt(merged.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        logger.warn(
          { jobId, value: merged.schedule_value },
          'Invalid interval in scheduler_update_job',
        );
        return;
      }
      updates.next_run = new Date(Date.now() + ms).toISOString();
    } else if (merged.schedule_type === 'once') {
      const date = new Date(merged.schedule_value);
      if (isNaN(date.getTime())) {
        logger.warn(
          { jobId, value: merged.schedule_value },
          'Invalid once timestamp in scheduler_update_job',
        );
        return;
      }
      updates.next_run = date.toISOString();
    } else {
      updates.next_run = null;
    }
  }

  updateJob(jobId, updates);
  deps.onSchedulerChanged();
};

const schedulerDeleteJobHandler: TaskHandler = (context) => {
  const { data, sourceGroup, isMain, deps, registeredGroups } = context;
  const jobId = (data.jobId || data.taskId || '').toString();
  if (!jobId) return;
  const job = getJobById(jobId);
  if (!job) return;
  if (!isMain && !jobBelongsToSourceGroup(job, sourceGroup, registeredGroups)) {
    logger.warn(
      {
        sourceGroup,
        groupScope: job.group_scope,
        linkedSessions: job.linked_sessions,
        jobId,
      },
      'Unauthorized scheduler_delete_job attempt blocked',
    );
    return;
  }
  deleteJob(jobId);
  deps.onSchedulerChanged();
};

const schedulerPauseJobHandler: TaskHandler = (context) => {
  const { data, sourceGroup, isMain, deps, registeredGroups } = context;
  const jobId = (data.jobId || data.taskId || '').toString();
  if (!jobId) return;
  const job = getJobById(jobId);
  if (!job) return;
  if (!isMain && !jobBelongsToSourceGroup(job, sourceGroup, registeredGroups)) {
    logger.warn(
      {
        sourceGroup,
        groupScope: job.group_scope,
        linkedSessions: job.linked_sessions,
        jobId,
      },
      'Unauthorized scheduler_pause_job attempt blocked',
    );
    return;
  }
  updateJob(jobId, {
    status: 'paused',
    pause_reason: 'Paused by user',
  });
  deps.onSchedulerChanged();
};

const schedulerResumeJobHandler: TaskHandler = (context) => {
  const { data, sourceGroup, isMain, deps, registeredGroups } = context;
  const jobId = (data.jobId || data.taskId || '').toString();
  if (!jobId) return;
  const job = getJobById(jobId);
  if (!job) return;
  if (!isMain && !jobBelongsToSourceGroup(job, sourceGroup, registeredGroups)) {
    logger.warn(
      {
        sourceGroup,
        groupScope: job.group_scope,
        linkedSessions: job.linked_sessions,
        jobId,
      },
      'Unauthorized scheduler_resume_job attempt blocked',
    );
    return;
  }
  updateJob(jobId, {
    status: 'active',
    pause_reason: null,
    next_run: job.next_run || new Date().toISOString(),
  });
  deps.onSchedulerChanged();
};

const schedulerTriggerJobHandler: TaskHandler = (context) => {
  const { data, sourceGroup, isMain, deps, registeredGroups } = context;
  const jobId = (data.jobId || data.taskId || '').toString();
  if (!jobId) return;
  const job = getJobById(jobId);
  if (!job) return;
  if (!isMain && !jobBelongsToSourceGroup(job, sourceGroup, registeredGroups)) {
    logger.warn(
      {
        sourceGroup,
        groupScope: job.group_scope,
        linkedSessions: job.linked_sessions,
        jobId,
      },
      'Unauthorized scheduler_trigger_job attempt blocked',
    );
    return;
  }
  updateJob(jobId, {
    status: 'active',
    next_run: new Date().toISOString(),
    pause_reason: null,
  });
  deps.onSchedulerChanged();
};

export const schedulerMutateTaskHandlers: Record<string, TaskHandler> = {
  scheduler_update_job: schedulerUpdateJobHandler,
  scheduler_delete_job: schedulerDeleteJobHandler,
  scheduler_pause_job: schedulerPauseJobHandler,
  scheduler_resume_job: schedulerResumeJobHandler,
  scheduler_trigger_job: schedulerTriggerJobHandler,
};
