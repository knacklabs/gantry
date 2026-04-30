import { logger } from '../infrastructure/logging/logger.js';
import { getRuntimeOpsRepository } from '../adapters/storage/postgres/runtime-store.js';
import { PgBossSchedulerEngine } from '../infrastructure/pgboss/scheduler-engine.js';
import { resetSchedulerRunSlots } from './concurrency.js';
import { sweepCompletedOneTimeJobs } from './cleanup.js';
import { resetSchedulerExecutionStateForTests, runJob } from './execution.js';
import { computeNextJobRun } from './schedule-math.js';
import { runtimeJobSchedulePlanner } from './job-schedule-planner.js';
import {
  _setMemoryMaintenanceQueueForTests,
  registerSystemJobs,
  resetSystemJobStateForTests,
} from './system-jobs.js';
import type {
  SchedulerDependencies,
  SchedulerDispatchPayload,
} from './types.js';

let activeSchedulerEngine: PgBossSchedulerEngine | null = null;
let schedulerRunning = false;

export type { SchedulerDependencies, SchedulerDispatchPayload };
export { computeNextJobRun, registerSystemJobs, runJob };
export { runtimeJobSchedulePlanner };
export { sweepCompletedOneTimeJobs };
export { _setMemoryMaintenanceQueueForTests };

export async function runSchedulerTick(
  deps: SchedulerDependencies,
): Promise<void> {
  deps = {
    ...deps,
    opsRepository: deps.opsRepository ?? getRuntimeOpsRepository(),
  };
  await registerSystemJobs(deps);
  activeSchedulerEngine?.requestSync();
}

export function requestSchedulerSync(jobId?: string): void {
  activeSchedulerEngine?.requestSync(jobId);
}

export async function enqueueJobTrigger(
  jobId: string,
  triggerId: string,
): Promise<void> {
  if (!activeSchedulerEngine) {
    throw new Error('Scheduler engine is not running');
  }
  await activeSchedulerEngine.enqueueTrigger(jobId, triggerId);
}

export async function startSchedulerLoop(
  deps: SchedulerDependencies,
): Promise<void> {
  if (schedulerRunning) return;
  schedulerRunning = true;
  const resolvedDeps = {
    ...deps,
    opsRepository: deps.opsRepository ?? getRuntimeOpsRepository(),
  };
  const engine = new PgBossSchedulerEngine(resolvedDeps, {
    registerSystemJobs,
    runJob,
    sweepCompletedOneTimeJobs,
  });
  activeSchedulerEngine = engine;
  try {
    await engine.start();
  } catch (err) {
    schedulerRunning = false;
    activeSchedulerEngine = null;
    await engine
      .stop()
      .catch((stopErr) =>
        logger.warn(
          { err: stopErr },
          'Failed to stop pg-boss after startup failure',
        ),
      );
    throw err;
  }
}

export async function stopSchedulerLoop(): Promise<void> {
  schedulerRunning = false;
  const engine = activeSchedulerEngine;
  activeSchedulerEngine = null;
  await engine?.stop();
}

export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
  activeSchedulerEngine = null;
  resetSchedulerExecutionStateForTests();
  resetSchedulerRunSlots();
  resetSystemJobStateForTests();
}

export function isSchedulerReady(): boolean {
  return activeSchedulerEngine?.isReady() === true;
}
