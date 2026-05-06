export type SchedulerJobStaleness = 'missed_window';

type SchedulerStalenessJob = {
  last_run: string | null;
  next_run: string | null;
  schedule_type: string;
  status: string;
};

export function schedulerJobStaleness(
  job: SchedulerStalenessJob,
  nowMs: number,
): SchedulerJobStaleness | null {
  if (
    job.status !== 'active' ||
    job.schedule_type !== 'once' ||
    job.last_run ||
    !job.next_run
  ) {
    return null;
  }
  const nextRunMs = Date.parse(job.next_run);
  if (!Number.isFinite(nextRunMs) || nextRunMs >= nowMs) return null;
  return 'missed_window';
}

export function staleOnceRequeueBucket(
  job: SchedulerStalenessJob,
  nowMs: number,
  throttleMs: number,
): number | null {
  return schedulerJobStaleness(job, nowMs) === 'missed_window'
    ? Math.floor(nowMs / throttleMs)
    : null;
}
