import { PgBoss } from 'pg-boss';
import { sweepCompletedOneTimeJobs } from './cleanup.js';
import { runJob } from './execution.js';
import { computeNextJobRun } from './schedule-math.js';
import { runtimeJobSchedulePlanner } from './job-schedule-planner.js';
import { _setMemoryMaintenanceQueueForTests, registerSystemJobs } from './system-jobs.js';
import type { SchedulerDependencies, SchedulerDispatchPayload } from './types.js';
/**
 * Factory for the ephemeral send-only pg-boss client used by non-executing
 * roles. Defaults to the real constructor; swapped in unit tests to assert the
 * start → ensureQueues → enqueue → stop ordering without a real database.
 */
type SendOnlyPgBossFactory = (options: ConstructorParameters<typeof PgBoss>[0]) => PgBoss;
/** @internal test hook */
export declare function _setSendOnlyPgBossFactoryForTests(factory: SendOnlyPgBossFactory | null): void;
/** Record that this process role does not run the scheduler (bootstrap-only). */
export declare function markRoleHasNoJobExecution(): void;
/**
 * Role-aware reason for an unready trigger queue, or undefined when the cause is
 * transient (the role runs jobs but the engine is still starting). For a
 * non-executing role this is only reached when there is no Postgres URL — with a
 * URL the trigger queue is ready and the trigger is enqueued for a job worker.
 */
export declare function schedulerNotReadyReason(): string | undefined;
export type { SchedulerDependencies, SchedulerDispatchPayload };
export { computeNextJobRun, registerSystemJobs, runJob };
export { runtimeJobSchedulePlanner };
export { sweepCompletedOneTimeJobs };
export { _setMemoryMaintenanceQueueForTests };
export declare function requestSchedulerSync(jobId?: string): void;
export declare function enqueueJobTrigger(jobId: string, triggerId: string, options?: {
    runId?: string;
}): Promise<void>;
export declare function startSchedulerLoop(deps: SchedulerDependencies): Promise<void>;
/** @internal test hook */
export declare function _hasQueuedLiveAdmissionWorkForTests(): Promise<boolean>;
export declare function stopSchedulerLoop(): Promise<void>;
export declare function _resetSchedulerLoopForTests(): void;
export declare function isSchedulerReady(): boolean;
export declare function isJobTriggerQueueReady(): boolean;
