import { createHash, randomUUID } from 'node:crypto';

import type { JobSchedulePlanner } from '../application/jobs/job-management-types.js';
import { ApplicationError } from '../application/common/application-error.js';
import { computeNextJobRun } from './schedule-math.js';
import { validateScheduleConfig } from './schedule.js';
import {
  nowIso as currentIso,
  nowMs as currentTimeMs,
} from '../shared/time/datetime.js';

function nowIso(): string {
  return currentIso();
}

export const runtimeJobSchedulePlanner: JobSchedulePlanner = {
  createManualJobId() {
    return randomUUID();
  },

  createJobId(params) {
    const base = JSON.stringify({
      name: params.name,
      prompt: params.prompt,
      scheduleType: params.scheduleType,
      scheduleValue: params.scheduleValue,
      workspaceKey: params.workspaceKey,
    });
    const hash = createHash('sha256').update(base).digest('hex').slice(0, 12);
    const slug = params.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40);
    return `job-${slug || 'scheduled'}-${hash}`;
  },

  planAppSchedule(input) {
    if (input.kind === 'once') {
      const scheduleValue = String(input.runAt || '').trim();
      if (!scheduleValue) {
        throw new ApplicationError(
          'INVALID_SCHEDULE',
          'runAt is required for once jobs',
        );
      }
      return { scheduleType: 'once', scheduleValue, nextRun: scheduleValue };
    }
    if (input.kind === 'recurring') {
      if (input.schedule?.type === 'interval') {
        const scheduleValue = String(input.schedule.value || '').trim();
        const ms = Number(scheduleValue);
        if (!/^[0-9]+$/.test(scheduleValue) || ms <= 0) {
          throw new ApplicationError(
            'INVALID_SCHEDULE',
            'interval schedules require a positive numeric value',
          );
        }
        return { scheduleType: 'interval', scheduleValue, nextRun: nowIso() };
      }
      const scheduleValue = String(input.schedule?.value || '').trim();
      if (!scheduleValue) {
        throw new ApplicationError(
          'INVALID_SCHEDULE',
          'cron schedules require a non-empty value',
        );
      }
      return { scheduleType: 'cron', scheduleValue, nextRun: nowIso() };
    }
    return { scheduleType: 'manual', scheduleValue: 'manual', nextRun: null };
  },

  planInitial(input) {
    const scheduleValue = input.scheduleValue.trim();
    if (input.scheduleType === 'cron') {
      const validationError = validateScheduleConfig({
        schedule_type: input.scheduleType,
        schedule_value: scheduleValue,
      });
      if (validationError) {
        throw new ApplicationError(
          'INVALID_SCHEDULE',
          'Invalid cron expression for scheduler job.',
        );
      }
      return {
        nextRun:
          computeNextJobRun(
            {
              schedule_type: input.scheduleType,
              schedule_value: scheduleValue,
            },
            nowIso(),
          ) ?? nowIso(),
      };
    }
    if (input.scheduleType === 'interval') {
      const ms = parseInt(scheduleValue, 10);
      if (Number.isNaN(ms) || ms <= 0) {
        throw new ApplicationError(
          'INVALID_SCHEDULE',
          'Invalid interval milliseconds for scheduler job.',
        );
      }
      return { nextRun: new Date(currentTimeMs() + ms).toISOString() };
    }
    const date = Date.parse(scheduleValue);
    if (!Number.isFinite(date)) {
      throw new ApplicationError(
        'INVALID_SCHEDULE',
        'Invalid once timestamp for scheduler job.',
      );
    }
    return { nextRun: new Date(date).toISOString() };
  },

  planResume(input) {
    const job = input.job;
    if (job.next_run) return job.next_run;
    if (job.schedule_type === 'manual') return null;
    if (job.schedule_type === 'once') {
      return Number.isFinite(Date.parse(job.schedule_value))
        ? job.schedule_value
        : undefined;
    }
    if (job.schedule_type === 'cron') {
      const validationError = validateScheduleConfig(job);
      return validationError ? undefined : input.clock.now();
    }
    if (job.schedule_type === 'interval') {
      const ms = parseInt(job.schedule_value, 10);
      if (!Number.isFinite(ms) || ms <= 0) return undefined;
      return input.clock.now();
    }
    return undefined;
  },
};
