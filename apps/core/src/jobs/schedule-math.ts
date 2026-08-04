import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from '../config/index.js';
import type { Job } from '../domain/types.js';
import {
  nowIso as currentIso,
  nowMs as currentTimeMs,
  toIso,
} from '../shared/time/datetime.js';

export function computeNextJobRun(
  job: Pick<Job, 'schedule_value'> & { schedule_type: string },
  scheduledFor: string | null,
): string | null {
  if (job.schedule_type === 'manual') {
    return null;
  }

  if (job.schedule_type === 'once') {
    return null;
  }

  if (job.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(job.schedule_value, {
      tz: TIMEZONE,
      currentDate: scheduledFor || currentIso(),
    });
    return interval.next().toISOString();
  }

  if (job.schedule_type !== 'interval') {
    return null;
  }

  const ms = parseInt(job.schedule_value, 10);
  if (!ms || ms <= 0) return null;

  const parsedAnchor = scheduledFor
    ? Date.parse(scheduledFor)
    : currentTimeMs();
  const anchor = Number.isFinite(parsedAnchor) ? parsedAnchor : currentTimeMs();
  const now = currentTimeMs();
  const steps = anchor >= now ? 1 : Math.floor((now - anchor) / ms) + 1;
  const next = anchor + steps * ms;

  if (!Number.isFinite(next) || Math.abs(next) > 8.64e15) return null;
  return toIso(next);
}
