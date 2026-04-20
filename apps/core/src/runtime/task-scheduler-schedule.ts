import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from '../core/config.js';

interface ScheduleValidationInput {
  schedule_type: string;
  schedule_value: string;
}

export function validateScheduleConfig(
  job: ScheduleValidationInput,
): string | null {
  const scheduleType = String(job.schedule_type);
  if (scheduleType === 'once') {
    const date = new Date(job.schedule_value);
    if (!Number.isFinite(date.getTime())) {
      return `Invalid once schedule_value: ${job.schedule_value}`;
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
