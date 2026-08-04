import { PgBoss } from 'pg-boss';
import type { Job } from '../../domain/types.js';
import type { ReleasedStaleJobLease } from '../../domain/repositories/ops-repo.js';
import type { SchedulerDependencies, SchedulerDispatchPayload } from '../../jobs/types.js';
export declare const SCHEDULER_MAINTENANCE_SYNC_INTERVAL_MS = 60000;
interface PgBossSchedulerCallbacks {
    registerSystemJobs: (deps: SchedulerDependencies) => Promise<void>;
    runJob: (job: Job, deps: SchedulerDependencies, queueJid: string, dispatch?: SchedulerDispatchPayload, control?: {
        abortSignal?: AbortSignal;
    }) => Promise<void>;
    sweepCompletedOneTimeJobs: (deps: SchedulerDependencies) => Promise<boolean>;
    handleReleasedStaleLeases?: (releases: readonly ReleasedStaleJobLease[], deps: SchedulerDependencies) => Promise<void>;
    rehydratePendingRecoveryTurns?: (jobs: readonly Job[], deps: SchedulerDependencies) => Promise<void>;
}
export declare class PgBossSchedulerEngine {
    private readonly deps;
    private readonly callbacks;
    private boss;
    private ready;
    private syncInFlight;
    private fullSyncRequested;
    private readonly pendingJobSyncs;
    private readonly scheduleSignatures;
    private maintenanceTimer;
    private starvationAlerter;
    constructor(deps: SchedulerDependencies, callbacks: PgBossSchedulerCallbacks);
    start(): Promise<void>;
    stop(): Promise<void>;
    isReady(): boolean;
    requestSync(jobId?: string): void;
    private startDrain;
    private startMaintenanceTimer;
    private stopMaintenanceTimer;
    enqueueTrigger(jobId: string, triggerId: string, options?: {
        runId?: string;
    }): Promise<void>;
    private ensureQueues;
    private drainSyncRequests;
    private syncAllJobs;
    private scanCapabilityStarvation;
    /**
     * Pause a fleet-starved job via the existing readiness pause path. The
     * requeue loop never reaches runJob for a fleet-wide-unsatisfiable job (every
     * worker requeues the delivery), so this is the only place such a job gets
     * paused. `pauseJobForSetupIfNeeded` re-checks fleet satisfiability itself —
     * if the gap closed between scan and pause it returns false and the job keeps
     * running normally.
     */
    private pauseStarvedJob;
    private recoverExpiredWorkerLeases;
    private syncOneJob;
    private syncJob;
    private scheduleSignature;
    private clearDeletedJob;
    private clearBossSchedule;
    private processBossJobs;
    /**
     * Capability eligibility gate. Returns true when the delivery was requeued
     * because THIS worker is ineligible for the job's required capability set —
     * the caller then skips runJob entirely.
     *
     * Requeue-without-retry-burn mechanism: instead of failing the run (which would
     * increment the job's `consecutive_failures` retry budget), this re-sends a
     * fresh delivery for the same job with `startAfter = now + delay + jitter` and
     * `retryLimit: 0`, then returns true so the CURRENT delivery completes normally
     * (pg-boss marks it completed, not failed/retried). The run is never claimed,
     * so no lease is taken, no terminal write occurs, and the retry budget is
     * untouched. An eligible worker claims the requeued delivery later; if no
     * worker is eligible, the periodic starvation scan pauses + alerts the job.
     *
     * No-op in workstation mode (single host is always locally eligible).
     */
    private requeuedIneligibleDelivery;
    private requeueCapacityBlockedDelivery;
    private persistRequiredCapabilities;
    private requireBoss;
}
export declare function ensureSchedulerQueues(boss: PgBoss): Promise<void>;
export declare function enqueueSchedulerTriggerDelivery(input: {
    boss: PgBoss;
    opsRepository: SchedulerDependencies['opsRepository'];
    jobId: string;
    triggerId: string;
    runId?: string;
}): Promise<void>;
export {};
