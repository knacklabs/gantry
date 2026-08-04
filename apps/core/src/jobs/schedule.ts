import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from '../config/index.js';
import { parseIso } from '../shared/time/datetime.js';

interface ScheduleValidationInput {
  schedule_type: string;
  schedule_value: string;
  next_run?: string | null;
}

export function validateScheduleConfig(
  job: ScheduleValidationInput,
): string | null {
  const scheduleType = String(job.schedule_type);
  if (scheduleType === 'manual') {
    return job.schedule_value === 'manual'
      ? null
      : `Invalid manual schedule_value: ${job.schedule_value}`;
  }

  if (scheduleType === 'once') {
    if (!parseIso(job.schedule_value)) {
      return `Invalid once schedule_value: ${job.schedule_value}`;
    }
    if (job.next_run && !parseIso(job.next_run)) {
      return `Invalid once next_run: ${job.next_run}`;
    }
    return null;
  }

  if (scheduleType === 'cron') {
    try {
      CronExpressionParser.parse(job.schedule_value, { tz: TIMEZONE });
      return null;
    } catch {
      return `Invalid cron schedule_value: ${job.schedule_value}`;
    }
  }

  if (scheduleType === 'interval') {
    const ms = parseInt(job.schedule_value, 10);
    if (!Number.isFinite(ms) || ms <= 0) {
      return `Invalid interval schedule_value: ${job.schedule_value}`;
    }
    return null;
  }

  return `Unsupported schedule_type: ${scheduleType}`;
}
