import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from '../core/config.js';
import { logger } from '../core/logger.js';
import { getJobById, upsertJob } from '../storage/db.js';
import { TaskHandler } from './ipc-task-types.js';
import {
  generateJobId,
  jobBelongsToSourceGroup,
  normalizeIpcExecutionMode,
} from './ipc-task-shared.js';

const schedulerOnceHandler: TaskHandler = async (context) => {
  const { data, sourceGroup, isMain, deps, registeredGroups, sourceGroupJids } =
    context;
  const name = (data.name || '').trim();
  const prompt = (data.prompt || '').trim();
  const runAtRaw = (data.runAt || data.schedule_value || '').trim();
  if (!name || !prompt || !runAtRaw) return;
  if (typeof data.script === 'string' && data.script.trim().length > 0) {
    logger.warn(
      { sourceGroup, name },
      'Rejected scheduler_once with script payload from IPC',
    );
    return;
  }

  const runAtDate = new Date(runAtRaw);
  if (isNaN(runAtDate.getTime())) {
    logger.warn({ runAtRaw }, 'Invalid run_at for scheduler_once');
    return;
  }

  const groupScope = (data.groupScope || sourceGroup).trim();
  if (!isMain && groupScope !== sourceGroup) {
    logger.warn(
      { sourceGroup, groupScope },
      'Unauthorized scheduler_once attempt blocked',
    );
    return;
  }

  let linkedSessions = Array.isArray(data.deliverTo)
    ? data.deliverTo.map((item) => String(item)).filter((item) => item)
    : sourceGroupJids;
  if (linkedSessions.length === 0) {
    linkedSessions = Array.isArray(data.linkedSessions)
      ? data.linkedSessions
          .map((item) => String(item))
          .filter((item) => item.length > 0)
      : sourceGroupJids;
  }
  if (linkedSessions.length === 0) linkedSessions = sourceGroupJids;
  if (linkedSessions.length === 0) {
    logger.warn(
      { sourceGroup, name },
      'scheduler_once requires at least one delivery session',
    );
    return;
  }

  if (!isMain) {
    const unauthorized = linkedSessions.some((jid) => {
      const group = registeredGroups[jid];
      return !group || group.folder !== sourceGroup;
    });
    if (unauthorized) {
      logger.warn(
        { sourceGroup, linkedSessions },
        'Unauthorized linked sessions in scheduler_once',
      );
      return;
    }
  }

  const scheduleValue = runAtDate.toISOString();
  const requestedJobId = (data.jobId || '').toString().trim();
  let id = generateJobId({
    name,
    prompt,
    scheduleType: 'once',
    scheduleValue,
    groupScope,
  });
  if (requestedJobId) {
    const existing = getJobById(requestedJobId);
    if (existing) {
      if (
        !isMain &&
        !jobBelongsToSourceGroup(existing, sourceGroup, registeredGroups)
      ) {
        logger.warn(
          { sourceGroup, requestedJobId },
          'Rejected scheduler_once with cross-group jobId',
        );
        return;
      }
      id = requestedJobId;
    } else {
      id = requestedJobId;
    }
  }

  const upsertResult = upsertJob({
    id,
    name,
    prompt,
    model: data.model || null,
    script: null,
    schedule_type: 'once',
    schedule_value: scheduleValue,
    linked_sessions: linkedSessions,
    thread_id: data.threadId || null,
    group_scope: groupScope,
    created_by: 'agent',
    status: 'active',
    next_run: scheduleValue,
    silent: data.silent === true,
    cleanup_after_ms:
      typeof data.cleanupAfterMs === 'number' ? data.cleanupAfterMs : undefined,
    timeout_ms: typeof data.timeoutMs === 'number' ? data.timeoutMs : undefined,
    max_retries:
      typeof data.maxRetries === 'number' ? data.maxRetries : undefined,
    retry_backoff_ms:
      typeof data.retryBackoffMs === 'number' ? data.retryBackoffMs : undefined,
    max_consecutive_failures:
      typeof data.maxConsecutiveFailures === 'number'
        ? data.maxConsecutiveFailures
        : undefined,
    execution_mode: normalizeIpcExecutionMode(
      data.executionMode,
      data.serialize,
    ),
  });

  logger.info(
    { id, created: upsertResult.created, sourceGroup, groupScope },
    'One-time job created via IPC',
  );
  deps.onSchedulerChanged();
};

const schedulerUpsertJobHandler: TaskHandler = async (context) => {
  const { data, sourceGroup, isMain, deps, registeredGroups, sourceGroupJids } =
    context;
  const scheduleType = (data.schedule_type || data.scheduleType) as
    | 'cron'
    | 'interval'
    | 'once'
    | 'manual';
  const scheduleValue = (data.schedule_value || data.scheduleValue || '')
    .toString()
    .trim();
  const name = (data.name || '').trim();
  const prompt = (data.prompt || '').trim();
  if (!name || !prompt || !scheduleType) return;
  if (typeof data.script === 'string' && data.script.trim().length > 0) {
    logger.warn(
      { sourceGroup, name },
      'Rejected scheduler_upsert_job with script payload from IPC',
    );
    return;
  }

  const groupScope = (data.groupScope || sourceGroup).trim();
  if (!isMain && groupScope !== sourceGroup) {
    logger.warn(
      { sourceGroup, groupScope },
      'Unauthorized scheduler_upsert_job attempt blocked',
    );
    return;
  }

  let linkedSessions = Array.isArray(data.deliverTo)
    ? data.deliverTo
        .map((item) => String(item))
        .filter((item) => item.length > 0)
    : Array.isArray(data.linkedSessions)
      ? data.linkedSessions
          .map((item) => String(item))
          .filter((item) => item.length > 0)
      : sourceGroupJids;
  if (linkedSessions.length === 0) linkedSessions = sourceGroupJids;
  if (linkedSessions.length === 0) {
    logger.warn(
      { sourceGroup, name },
      'scheduler_upsert_job requires at least one linked session',
    );
    return;
  }

  if (!isMain) {
    const unauthorized = linkedSessions.some((jid) => {
      const group = registeredGroups[jid];
      return !group || group.folder !== sourceGroup;
    });
    if (unauthorized) {
      logger.warn(
        { sourceGroup, linkedSessions },
        'Unauthorized linked sessions in scheduler_upsert_job',
      );
      return;
    }
  }

  let nextRun: string | null = null;
  if (scheduleType === 'cron') {
    try {
      const interval = CronExpressionParser.parse(scheduleValue, {
        tz: TIMEZONE,
      });
      nextRun = interval.next().toISOString();
    } catch {
      logger.warn({ scheduleValue }, 'Invalid cron expression for job');
      return;
    }
  } else if (scheduleType === 'interval') {
    const ms = parseInt(scheduleValue, 10);
    if (isNaN(ms) || ms <= 0) {
      logger.warn({ scheduleValue }, 'Invalid interval for job');
      return;
    }
    nextRun = new Date(Date.now() + ms).toISOString();
  } else if (scheduleType === 'once') {
    const date = new Date(scheduleValue);
    if (isNaN(date.getTime())) {
      logger.warn({ scheduleValue }, 'Invalid once timestamp for job');
      return;
    }
    nextRun = date.toISOString();
  } else if (scheduleType === 'manual') {
    nextRun = null;
  } else {
    return;
  }

  const requestedJobId = (data.jobId || '').toString().trim();
  let id = generateJobId({
    name,
    prompt,
    scheduleType,
    scheduleValue,
    groupScope,
  });
  if (requestedJobId) {
    const existing = getJobById(requestedJobId);
    if (existing) {
      if (
        !isMain &&
        !jobBelongsToSourceGroup(existing, sourceGroup, registeredGroups)
      ) {
        logger.warn(
          { sourceGroup, requestedJobId },
          'Rejected scheduler_upsert_job with cross-group jobId',
        );
        return;
      }
      id = requestedJobId;
    } else {
      id = requestedJobId;
    }
  }

  const upsertResult = upsertJob({
    id,
    name,
    prompt,
    model: data.model || null,
    script: null,
    schedule_type: scheduleType,
    schedule_value: scheduleValue,
    linked_sessions: linkedSessions,
    thread_id: data.threadId || null,
    group_scope: groupScope,
    created_by: 'agent',
    status: 'active',
    next_run: nextRun,
    silent: data.silent === true,
    cleanup_after_ms:
      typeof data.cleanupAfterMs === 'number' ? data.cleanupAfterMs : undefined,
    timeout_ms: typeof data.timeoutMs === 'number' ? data.timeoutMs : undefined,
    max_retries:
      typeof data.maxRetries === 'number' ? data.maxRetries : undefined,
    retry_backoff_ms:
      typeof data.retryBackoffMs === 'number' ? data.retryBackoffMs : undefined,
    max_consecutive_failures:
      typeof data.maxConsecutiveFailures === 'number'
        ? data.maxConsecutiveFailures
        : undefined,
    execution_mode: normalizeIpcExecutionMode(
      data.executionMode,
      data.serialize,
    ),
  });

  logger.info(
    { id, created: upsertResult.created, sourceGroup, groupScope },
    'Job upserted via IPC',
  );
  deps.onSchedulerChanged();
};

export const schedulerCreateTaskHandlers: Record<string, TaskHandler> = {
  scheduler_once: schedulerOnceHandler,
  scheduler_upsert_job: schedulerUpsertJobHandler,
};
