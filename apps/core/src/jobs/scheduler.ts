import { PgBoss } from 'pg-boss';

import { logger } from '../infrastructure/logging/logger.js';
import {
  getRuntimeControlRepository,
  getRuntimeEventExchange,
  getRuntimeRepositories,
  getRuntimeStorage,
  getWorkerCoordinationRepository,
} from '../adapters/storage/postgres/runtime-store.js';
import {
  PgBossSchedulerEngine,
  enqueueSchedulerTriggerDelivery,
  ensureSchedulerQueues,
} from '../infrastructure/pgboss/scheduler-engine.js';
import {
  STORAGE_POSTGRES_SCHEMA,
  STORAGE_POSTGRES_URL,
} from '../config/index.js';
import {
  configureRunSlotBackend,
  resetSchedulerRunSlots,
} from './concurrency.js';
import {
  registerWorkerInstance,
  stopWorkerHeartbeat,
} from './worker-identity.js';
import { sweepCompletedOneTimeJobs } from './cleanup.js';
import { runJob } from './execution.js';
import { computeNextJobRun } from './schedule-math.js';
import { runtimeJobSchedulePlanner } from './job-schedule-planner.js';
import { notifyReleasedStaleJobLeases } from './stale-lease-terminal.js';
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

/**
 * Factory for the ephemeral send-only pg-boss client used by non-executing
 * roles. Defaults to the real constructor; swapped in unit tests to assert the
 * start → ensureQueues → enqueue → stop ordering without a real database.
 */
type SendOnlyPgBossFactory = (
  options: ConstructorParameters<typeof PgBoss>[0],
) => PgBoss;
let sendOnlyPgBossFactory: SendOnlyPgBossFactory = (options) =>
  new PgBoss(options);

/** @internal test hook */
export function _setSendOnlyPgBossFactoryForTests(
  factory: SendOnlyPgBossFactory | null,
): void {
  sendOnlyPgBossFactory = factory ?? ((options) => new PgBoss(options));
}
/**
 * Set at bootstrap when the process role does not claim scheduled jobs
 * (`jobExecution=false`). The scheduler loop is never started in that case, so
 * `isSchedulerReady()` is permanently false — but such a role can still enqueue
 * a manual trigger via an ephemeral send-only pg-boss client when a Postgres URL
 * is configured (a job worker then claims it). Threaded into trigger error
 * messages so the user gets a plain explanation instead of "Scheduler is not
 * ready".
 */
let roleHasNoJobExecution = false;

/** Record that this process role does not run the scheduler (bootstrap-only). */
export function markRoleHasNoJobExecution(): void {
  roleHasNoJobExecution = true;
}

/**
 * Role-aware reason for an unready trigger queue, or undefined when the cause is
 * transient (the role runs jobs but the engine is still starting). For a
 * non-executing role this is only reached when there is no Postgres URL — with a
 * URL the trigger queue is ready and the trigger is enqueued for a job worker.
 */
export function schedulerNotReadyReason(): string | undefined {
  if (!roleHasNoJobExecution) return undefined;
  return (
    'This process role cannot enqueue job triggers without a configured ' +
    'Postgres URL; the job will still run on its schedule once storage is set.'
  );
}

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
    opsRepository: deps.opsRepository ?? getRuntimeRepositories(),
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
  options?: { runId?: string },
): Promise<void> {
  if (activeSchedulerEngine) {
    await activeSchedulerEngine.enqueueTrigger(jobId, triggerId, options);
    return;
  }
  if (!roleHasNoJobExecution) {
    throw new Error('Scheduler engine is not running');
  }
  await enqueueJobTriggerFromNonExecutingRole(jobId, triggerId, options);
}

async function enqueueJobTriggerFromNonExecutingRole(
  jobId: string,
  triggerId: string,
  options?: { runId?: string },
): Promise<void> {
  if (!STORAGE_POSTGRES_URL) {
    throw new Error('Postgres URL is required before enqueueing job triggers');
  }
  // Send-only ephemeral client (pg-boss 12.x). A control / live-worker role does
  // not run the scheduler, so this client must only enqueue a delivery and exit.
  // It must NOT start any of pg-boss's background subsystems:
  //   - schedule:false  -> Timekeeper.start() is skipped: no cron monitor / clock
  //     skew intervals and no SEND_IT worker, so this call can never fire another
  //     job's scheduled cron send while it is briefly connected.
  //   - supervise:false -> Boss.start() is skipped: no maintenance/expiration
  //     superviseInterval timer (and nothing to race the job-worker's maintenance).
  //   - migrate:false   -> Contractor.check() runs instead of start(): it throws a
  //     clear "pg-boss is not installed" / "requires migrations" error if the
  //     schema is absent rather than silently migrating, and Bam.start() (block
  //     monitor) is skipped. A control/worker process always boots after a
  //     job-worker has migrated the pgboss schema, so migration here is never
  //     needed; if it ever is, failing loudly is correct.
  // Manager.start() still runs (required for send()), creating one queueCache
  // interval that boss.stop() clears in the finally below, so the process exits
  // cleanly (AGENTS.md background-timer rule). createSchema is omitted because it
  // is only consulted on the migrate path, which is disabled.
  const boss = sendOnlyPgBossFactory({
    connectionString: STORAGE_POSTGRES_URL,
    schema: 'pgboss',
    migrate: false,
    schedule: false,
    supervise: false,
    application_name: `gantry-${STORAGE_POSTGRES_SCHEMA}-job-trigger`,
  });
  boss.on('error', (err) => {
    logger.error({ err }, 'pg-boss trigger enqueue error');
  });
  await boss.start();
  try {
    await ensureSchedulerQueues(boss);
    await enqueueSchedulerTriggerDelivery({
      boss,
      opsRepository: getRuntimeRepositories(),
      jobId,
      triggerId,
      runId: options?.runId,
    });
  } finally {
    await boss.stop({ graceful: true, close: true, timeout: 10_000 });
  }
}

export async function startSchedulerLoop(
  deps: SchedulerDependencies,
): Promise<void> {
  if (schedulerRunning) return;
  schedulerRunning = true;
  const resolvedDeps = {
    ...deps,
    opsRepository: deps.opsRepository ?? getRuntimeRepositories(),
    hasLiveAdmissionBacklog:
      deps.hasLiveAdmissionBacklog ?? hasQueuedLiveAdmissionWork,
  };
  const warn = (context: Record<string, unknown>, message: string): void =>
    logger.warn(context, message);
  const workerCoordination = getWorkerCoordinationRepository();
  const workerInstanceId = await registerWorkerInstance(workerCoordination, {
    warn,
    processRole: deps.processRole,
  });
  configureRunSlotBackend({
    repository: workerCoordination,
    workerInstanceId,
    warn,
  });
  const engine = new PgBossSchedulerEngine(resolvedDeps, {
    registerSystemJobs,
    runJob,
    sweepCompletedOneTimeJobs,
    handleReleasedStaleLeases: (releases, callbackDeps) =>
      notifyReleasedStaleJobLeases({
        releases,
        opsRepository: callbackDeps.opsRepository,
        sendMessage: callbackDeps.sendMessage,
        controlRepository: getRuntimeControlRepository(),
        publishRuntimeEvent: async (event) => {
          await getRuntimeEventExchange().publish(event);
        },
        logger,
      }),
  });
  activeSchedulerEngine = engine;
  try {
    await engine.start();
  } catch (err) {
    schedulerRunning = false;
    activeSchedulerEngine = null;
    stopWorkerHeartbeat();
    configureRunSlotBackend(null);
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

async function hasQueuedLiveAdmissionWork(): Promise<boolean> {
  const result = await getRuntimeStorage().service.pool.query<{
    waiting: boolean;
  }>(
    `SELECT EXISTS (
       SELECT 1 FROM live_admission_work_items
       WHERE state = 'queued'
          OR (
            state = 'deferred'
            AND (defer_until IS NULL OR defer_until <= now())
          )
       LIMIT 1
     ) AS waiting`,
  );
  return result.rows[0]?.waiting === true;
}

/** @internal test hook */
export async function _hasQueuedLiveAdmissionWorkForTests(): Promise<boolean> {
  return hasQueuedLiveAdmissionWork();
}

export async function stopSchedulerLoop(): Promise<void> {
  schedulerRunning = false;
  const engine = activeSchedulerEngine;
  activeSchedulerEngine = null;
  stopWorkerHeartbeat();
  configureRunSlotBackend(null);
  await engine?.stop();
}

export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
  activeSchedulerEngine = null;
  roleHasNoJobExecution = false;
  stopWorkerHeartbeat();
  resetSchedulerRunSlots();
  resetSystemJobStateForTests();
}

export function isSchedulerReady(): boolean {
  return activeSchedulerEngine?.isReady() === true;
}

export function isJobTriggerQueueReady(): boolean {
  return (
    isSchedulerReady() ||
    (roleHasNoJobExecution && Boolean(STORAGE_POSTGRES_URL))
  );
}
