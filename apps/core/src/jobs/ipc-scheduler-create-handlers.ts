import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from '../config/index.js';
import { nowMs, parseIso, toIso } from '../infrastructure/time/datetime.js';
import { logger } from '../infrastructure/logging/logger.js';
import { TaskHandler } from './ipc-types.js';
import { invalidateSystemJobRegistrationSignature } from './system-registration-cache.js';
import {
  createTaskResponder,
  generateJobId,
  jobBelongsToAuthThread,
  jobBelongsToSourceGroup,
  normalizeIpcExecutionMode,
} from './ipc-shared.js';

const schedulerUpsertJobHandler: TaskHandler = async (context) => {
  const { data, sourceGroup, isMain, deps, registeredGroups, sourceGroupJids } =
    context;
  const { accept, reject } = createTaskResponder(
    sourceGroup,
    data.taskId,
    data.authThreadId,
  );

  try {
    const scheduleType = data.scheduleType as
      | 'cron'
      | 'interval'
      | 'once'
      | undefined;
    const scheduleValue = (data.scheduleValue || '').toString().trim();
    const name = (data.name || '').trim();
    const prompt = (data.prompt || '').trim();
    if (!name || !prompt || !scheduleType) {
      reject(
        'scheduler_upsert_job requires name, prompt, and scheduleType.',
        'invalid_request',
      );
      return;
    }
    if (typeof data.script === 'string' && data.script.trim().length > 0) {
      logger.warn(
        { sourceGroup, name },
        'Rejected scheduler_upsert_job with script payload from IPC',
      );
      reject(
        'script mutation is not allowed for scheduler_upsert_job.',
        'forbidden',
      );
      return;
    }

    const groupScope = (data.groupScope || sourceGroup).trim();
    if (!isMain && groupScope !== sourceGroup) {
      logger.warn(
        { sourceGroup, groupScope },
        'Unauthorized scheduler_upsert_job attempt blocked',
      );
      reject(
        'Only the main agent can set groupScope outside the source group.',
        'forbidden',
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
      reject(
        'scheduler_upsert_job requires at least one linked session.',
        'invalid_request',
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
        reject(
          'linked_sessions must belong to the source group for non-main agents.',
          'forbidden',
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
        reject(
          'Invalid cron expression for scheduler job.',
          'invalid_schedule',
        );
        return;
      }
    } else if (scheduleType === 'interval') {
      const ms = parseInt(scheduleValue, 10);
      if (isNaN(ms) || ms <= 0) {
        logger.warn({ scheduleValue }, 'Invalid interval for job');
        reject(
          'Invalid interval milliseconds for scheduler job.',
          'invalid_schedule',
        );
        return;
      }
      nextRun = toIso(nowMs() + ms);
    } else if (scheduleType === 'once') {
      const date = parseIso(scheduleValue);
      if (!date) {
        logger.warn({ scheduleValue }, 'Invalid once timestamp for job');
        reject('Invalid once timestamp for scheduler job.', 'invalid_schedule');
        return;
      }
      nextRun = toIso(date);
    } else {
      reject('Unsupported schedule type.', 'invalid_schedule');
      return;
    }

    const requestedJobId = (data.jobId || '').toString().trim();
    const authThreadId =
      typeof data.authThreadId === 'string' ? data.authThreadId : undefined;
    const payloadThreadId =
      typeof data.threadId === 'string' ? data.threadId : undefined;
    if (authThreadId && payloadThreadId && payloadThreadId !== authThreadId) {
      logger.warn(
        { sourceGroup, requestedJobId, authThreadId },
        'Rejected scheduler_upsert_job with mismatched thread binding',
      );
      reject(
        'threadId payload does not match authenticated thread binding.',
        'forbidden',
      );
      return;
    }
    let id = generateJobId({
      name,
      prompt,
      scheduleType,
      scheduleValue,
      groupScope,
    });
    let existingJob = null;
    if (requestedJobId) {
      const existing = await deps.opsRepository.getJobById(requestedJobId);
      if (existing) {
        if (
          !isMain &&
          !jobBelongsToSourceGroup(existing, sourceGroup, registeredGroups)
        ) {
          logger.warn(
            { sourceGroup, requestedJobId },
            'Rejected scheduler_upsert_job with cross-group job_id',
          );
          reject(
            'Requested job_id does not belong to the source group.',
            'forbidden',
          );
          return;
        }
        if (!jobBelongsToAuthThread(existing, authThreadId)) {
          logger.warn(
            { sourceGroup, requestedJobId, authThreadId },
            'Rejected scheduler_upsert_job with cross-thread job_id',
          );
          reject(
            'Requested job_id belongs to a different thread.',
            'forbidden',
          );
          return;
        }
        existingJob = existing;
        id = requestedJobId;
      } else {
        id = requestedJobId;
      }
    }
    existingJob ??= await deps.opsRepository.getJobById(id);
    if (existingJob && !jobBelongsToAuthThread(existingJob, authThreadId)) {
      logger.warn(
        { sourceGroup, requestedJobId: id, authThreadId },
        'Rejected scheduler_upsert_job with cross-thread job_id',
      );
      reject('Requested job_id belongs to a different thread.', 'forbidden');
      return;
    }

    const upsertResult = await deps.opsRepository.upsertJob({
      id,
      name,
      prompt,
      model: data.model || null,
      script: null,
      schedule_type: scheduleType,
      schedule_value: scheduleValue,
      linked_sessions: linkedSessions,
      session_id: null,
      thread_id: authThreadId ?? payloadThreadId ?? null,
      group_scope: groupScope,
      created_by: data.createdBy === 'human' ? 'human' : 'agent',
      status: 'active',
      next_run: nextRun,
      silent: data.silent === true,
      cleanup_after_ms:
        typeof data.cleanupAfterMs === 'number'
          ? data.cleanupAfterMs
          : undefined,
      timeout_ms:
        typeof data.timeoutMs === 'number' ? data.timeoutMs : undefined,
      max_retries:
        typeof data.maxRetries === 'number' ? data.maxRetries : undefined,
      retry_backoff_ms:
        typeof data.retryBackoffMs === 'number'
          ? data.retryBackoffMs
          : undefined,
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
    invalidateSystemJobRegistrationSignature(deps.opsRepository);
    deps.onSchedulerChanged(id);
    accept(
      upsertResult.created
        ? `Scheduler job created (${id}).`
        : `Scheduler job updated (${id}).`,
    );
  } catch (err) {
    logger.error(
      { err, sourceGroup },
      'scheduler_upsert_job failed unexpectedly',
    );
    reject(
      err instanceof Error ? err.message : 'Failed to upsert scheduler job.',
      'internal_error',
    );
  }
};

export const schedulerCreateTaskHandlers: Record<string, TaskHandler> = {
  scheduler_upsert_job: schedulerUpsertJobHandler,
};
