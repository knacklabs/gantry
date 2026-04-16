import fs from 'fs';
import path from 'path';

import { SCHEDULER_JOBS_JSON_PATH } from '../core/config.js';
import { Job, JobEvent, JobRun } from '../core/types.js';
import { logger } from '../core/logger.js';

export function writeSchedulerStateFile(
  jobs: Job[],
  runs: JobRun[],
  events: JobEvent[],
  filePath: string = SCHEDULER_JOBS_JSON_PATH,
): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const payload = {
    updated_at: new Date().toISOString(),
    jobs,
    recent_runs: runs,
    recent_events: events,
  };

  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2));
  fs.renameSync(tempPath, filePath);
}

export function writeSchedulerStateFileSafe(
  jobs: Job[],
  runs: JobRun[],
  events: JobEvent[],
): void {
  try {
    writeSchedulerStateFile(jobs, runs, events);
  } catch (err) {
    logger.warn({ err }, 'Failed to write scheduler state JSON');
  }
}
