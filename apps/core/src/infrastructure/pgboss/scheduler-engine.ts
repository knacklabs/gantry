import { createHash, randomUUID } from 'node:crypto';
import { PgBoss, type Job as PgBossJob } from 'pg-boss';

import {
  STORAGE_POSTGRES_SCHEMA,
  STORAGE_POSTGRES_URL,
  TIMEZONE,
  getDeploymentMode,
  getRuntimeQueueConfig,
} from '../../config/index.js';
import { logger } from '../logging/logger.js';
import type { Job } from '../../domain/types.js';
import type { ReleasedStaleJobLease } from '../../domain/repositories/ops-repo.js';
import {
  getRuntimeControlRepository,
  getRuntimeEventExchange,
  getRuntimeStorage,
  getWorkerCoordinationRepository,
} from '../../adapters/storage/postgres/runtime-store.js';
import { tryAcquireRunSlot } from '../../jobs/concurrency.js';
import {
  decideCapabilityDispatch,
  ineligibleRequeueDelayMs,
  requiredCapabilitiesChanged,
} from '../../jobs/capability-dispatch.js';
import { CapabilityStarvationAlerter } from '../../jobs/capability-starvation.js';
import { scanCapabilityStarvation } from '../../jobs/capability-starvation-scan.js';
import { pauseJobForSetupIfNeeded } from '../../jobs/execution-readiness.js';
import { resolveAppSessionForJob } from '../../jobs/app-session-resolution.js';
import { agentIdForJobWorkspaceKey } from '../../application/jobs/job-tool-policy.js';
import { DEFAULT_JOB_RUNTIME_APP_ID } from '../../application/jobs/job-access.js';
import { currentWorkerInstanceId } from '../../jobs/worker-identity.js';
import { WORKER_STALE_AFTER_MS } from '../../shared/worker-heartbeat.js';
import { validateScheduleConfig } from '../../jobs/schedule.js';
import type {
  SchedulerDependencies,
  SchedulerDispatchPayload,
} from '../../jobs/types.js';
import {
  schedulerJobStaleness,
  staleOnceRequeueBucket,
} from '../../shared/scheduler-job-staleness.js';
import { nowMs as currentTimeMs, toIso } from '../../shared/time/datetime.js';

const SCHEDULER_QUEUE = 'gantry.jobs';
const SCHEDULER_QUEUE_DEAD_LETTER = 'gantry.jobs.dead_letter';
const PGBOSS_KEY_PREFIX = 'gantry';
const STALE_ONCE_REENQUEUE_THROTTLE_MS = 60_000;
export const SCHEDULER_MAINTENANCE_SYNC_INTERVAL_MS = 60_000;

interface PgBossSchedulerCallbacks {
  registerSystemJobs: (deps: SchedulerDependencies) => Promise<void>;
  runJob: (
    job: Job,
    deps: SchedulerDependencies,
    queueJid: string,
    dispatch?: SchedulerDispatchPayload,
  ) => Promise<void>;
  sweepCompletedOneTimeJobs: (deps: SchedulerDependencies) => Promise<boolean>;
  handleReleasedStaleLeases?: (
    releases: readonly ReleasedStaleJobLease[],
    deps: SchedulerDependencies,
  ) => Promise<void>;
  rehydratePendingRecoveryTurns?: (
    jobs: readonly Job[],
    deps: SchedulerDependencies,
  ) => Promise<void>;
}

function pgBossKey(kind: string, value: string): string {
  return `${PGBOSS_KEY_PREFIX}.${kind}.${Buffer.from(value).toString('base64url')}`;
}

function pgBossGroupId(workspaceKey: string): string {
  return pgBossKey('group', workspaceKey);
}

function pgBossJobKey(jobId: string): string {
  return pgBossKey('job', jobId);
}

function pgBossSendId(jobId: string, slot: string): string {
  const bytes = createHash('sha256')
    .update(`${PGBOSS_KEY_PREFIX}:send:${jobId}:${slot}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

function scheduleSlotForJob(job: Job): string {
  return job.schedule_type === 'interval' ? 'interval' : 'once';
}

function isRunnableScheduledJob(job: Job): boolean {
  return (
    job.status === 'active' &&
    job.schedule_type !== 'manual' &&
    Boolean(job.next_run)
  );
}

function pgBossStartAfter(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid scheduler next_run: ${value}`);
  }
  return date;
}

function schedulerQueueJid(workspaceKey: string, jobId?: string): string {
  return `__scheduler__:${workspaceKey}${jobId ? `:${jobId}` : ''}`;
}

export class PgBossSchedulerEngine {
  private boss: PgBoss | null = null;
  private ready = false;
  private syncInFlight: Promise<void> | null = null;
  private fullSyncRequested = false;
  private readonly pendingJobSyncs = new Set<string>();
  private readonly scheduleSignatures = new Map<string, string>();
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;
  private starvationAlerter: CapabilityStarvationAlerter | null = null;

  constructor(
    private readonly deps: SchedulerDependencies,
    private readonly callbacks: PgBossSchedulerCallbacks,
  ) {}

  async start(): Promise<void> {
    if (!STORAGE_POSTGRES_URL) {
      throw new Error('Postgres URL is required before starting pg-boss');
    }
    const boss = new PgBoss({
      connectionString: STORAGE_POSTGRES_URL,
      schema: 'pgboss',
      createSchema: true,
      migrate: true,
      schedule: true,
      application_name: `gantry-${STORAGE_POSTGRES_SCHEMA}-jobs`,
    });
    boss.on('error', (err) => {
      logger.error({ err }, 'pg-boss scheduler error');
    });
    await boss.start();
    this.boss = boss;
    await this.ensureQueues();
    const queuePolicy = getRuntimeQueueConfig();
    await boss.work<SchedulerDispatchPayload>(
      SCHEDULER_QUEUE,
      {
        batchSize: 1,
        pollingIntervalSeconds: 1,
        localConcurrency: queuePolicy.maxJobRuns,
      },
      (jobs) => this.processBossJobs(jobs),
    );
    await this.syncAllJobs();
    this.ready = true;
    this.startMaintenanceTimer();
  }

  async stop(): Promise<void> {
    const boss = this.boss;
    this.ready = false;
    this.boss = null;
    this.stopMaintenanceTimer();
    await boss?.stop({ graceful: true, close: true, timeout: 10_000 });
  }

  isReady(): boolean {
    return this.ready;
  }

  requestSync(jobId?: string): void {
    if (jobId) {
      this.pendingJobSyncs.add(jobId);
    } else {
      this.fullSyncRequested = true;
    }
    this.startDrain();
  }

  private startDrain(): void {
    if (this.syncInFlight) return;
    this.syncInFlight = this.drainSyncRequests()
      .catch((err) => logger.warn({ err }, 'Failed to sync pg-boss jobs'))
      .finally(() => {
        this.syncInFlight = null;
        if (this.fullSyncRequested || this.pendingJobSyncs.size > 0)
          this.startDrain();
      });
  }

  private startMaintenanceTimer(): void {
    if (this.maintenanceTimer) return;
    const timer = setInterval(
      () => this.requestSync(),
      SCHEDULER_MAINTENANCE_SYNC_INTERVAL_MS,
    );
    (
      timer as ReturnType<typeof setInterval> & { unref?: () => void }
    ).unref?.();
    this.maintenanceTimer = timer;
  }

  private stopMaintenanceTimer(): void {
    if (!this.maintenanceTimer) return;
    clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = null;
  }

  async enqueueTrigger(
    jobId: string,
    triggerId: string,
    options?: { runId?: string },
  ): Promise<void> {
    await enqueueSchedulerTriggerDelivery({
      boss: this.requireBoss(),
      opsRepository: this.deps.opsRepository,
      jobId,
      triggerId,
      runId: options?.runId,
    });
  }

  private async ensureQueues(): Promise<void> {
    await ensureSchedulerQueues(this.requireBoss());
  }

  private async drainSyncRequests(): Promise<void> {
    while (this.fullSyncRequested || this.pendingJobSyncs.size > 0) {
      if (this.fullSyncRequested) {
        this.fullSyncRequested = false;
        this.pendingJobSyncs.clear();
        await this.syncAllJobs();
        continue;
      }
      const jobIds = [...this.pendingJobSyncs];
      this.pendingJobSyncs.clear();
      for (const jobId of jobIds) {
        await this.syncOneJob(jobId);
      }
    }
  }

  private async syncAllJobs(): Promise<void> {
    const boss = this.requireBoss();
    await this.callbacks.registerSystemJobs(this.deps);
    await this.recoverExpiredWorkerLeases();
    const released = await this.deps.opsRepository.releaseStaleJobLeases();
    if (released.length > 0) {
      logger.warn(
        { count: released.length },
        'Released stale scheduler leases',
      );
      await this.callbacks.handleReleasedStaleLeases?.(released, this.deps);
      this.scheduleSignatures.clear();
      this.deps.onSchedulerChanged?.();
    }
    const removed = await this.callbacks.sweepCompletedOneTimeJobs(this.deps);
    if (removed) this.deps.onSchedulerChanged?.();
    const jobs = await this.deps.opsRepository.getAllJobs();
    const liveJobIds = new Set(jobs.map((job) => job.id));
    for (const job of jobs) {
      await this.syncJob(boss, job);
    }
    try {
      await this.callbacks.rehydratePendingRecoveryTurns?.(jobs, this.deps);
    } catch (err) {
      logger.warn({ err }, 'Failed to rehydrate scheduler recovery turns');
    }
    await this.scanCapabilityStarvation(jobs);
    for (const jobId of this.scheduleSignatures.keys()) {
      if (!liveJobIds.has(jobId)) await this.clearDeletedJob(boss, jobId);
    }
  }

  /**
   * Fleet-only capability-starvation safety net, driven by the (stoppable)
   * maintenance sync. Alerts due jobs whose required capability set no active
   * worker satisfies — the case the requeue-without-retry-burn loop would
   * otherwise let starve silently — and pauses them through the existing
   * readiness pause path so they stop requeueing and surface one clear user
   * action. No-op in workstation mode.
   */
  private async scanCapabilityStarvation(jobs: readonly Job[]): Promise<void> {
    if (getDeploymentMode() !== 'fleet') return;
    try {
      const storage = getRuntimeStorage();
      if (!this.starvationAlerter) {
        this.starvationAlerter = new CapabilityStarvationAlerter({
          publishRuntimeEvent: (event) =>
            getRuntimeEventExchange().publish(event),
          warn: (context, message) => logger.warn(context, message),
        });
      }
      await scanCapabilityStarvation(
        {
          skills: this.deps.getSkillRepository?.(),
          runtimeDependencies: storage.repositories.runtimeDependencies,
          workerRegistry: getWorkerCoordinationRepository(),
          alerter: this.starvationAlerter,
          pauseStarvedJob: (job) => this.pauseStarvedJob(job),
        },
        jobs,
      );
    } catch (err) {
      logger.warn({ err }, 'Capability-starvation scan failed');
    }
  }

  /**
   * Pause a fleet-starved job via the existing readiness pause path. The
   * requeue loop never reaches runJob for a fleet-wide-unsatisfiable job (every
   * worker requeues the delivery), so this is the only place such a job gets
   * paused. `pauseJobForSetupIfNeeded` re-checks fleet satisfiability itself —
   * if the gap closed between scan and pause it returns false and the job keeps
   * running normally.
   */
  private async pauseStarvedJob(job: Job): Promise<boolean> {
    const appSession = await resolveAppSessionForJob(
      job,
      getRuntimeControlRepository(),
    );
    return pauseJobForSetupIfNeeded({
      currentJob: job,
      deps: this.deps,
      executionAgentFolder: job.workspace_key,
      agentId: agentIdForJobWorkspaceKey(job.workspace_key),
      runtimeAppId: DEFAULT_JOB_RUNTIME_APP_ID,
      appSession,
      source: 'preflight_setup',
      publishRuntimeEvent: (event) => getRuntimeEventExchange().publish(event),
    });
  }

  /**
   * Stale recovery only: marks heartbeat-lapsed workers unhealthy and expires
   * run leases whose lease window has lapsed. Live leases held by healthy
   * workers — including a previous incarnation of this process — are never
   * released here.
   */
  private async recoverExpiredWorkerLeases(): Promise<void> {
    try {
      const coordination = getWorkerCoordinationRepository();
      const unhealthy = await coordination.markStaleWorkersUnhealthy({
        staleBefore: toIso(currentTimeMs() - WORKER_STALE_AFTER_MS),
      });
      if (unhealthy.length > 0) {
        logger.warn(
          { workerInstanceIds: unhealthy },
          'Marked heartbeat-lapsed worker instances unhealthy',
        );
      }
      const recovered = await coordination.recoverExpiredRunLeases({});
      if (recovered.length > 0) {
        logger.warn(
          {
            count: recovered.length,
            leases: recovered.map((lease) => ({
              runId: lease.runId,
              jobId: lease.jobId,
              workerInstanceId: lease.workerInstanceId,
              fencingVersion: lease.fencingVersion,
            })),
          },
          'Expired lapsed run leases; runs are retryable with a higher fencing version',
        );
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to recover expired worker run leases');
    }
  }

  private async syncOneJob(jobId: string): Promise<void> {
    const boss = this.requireBoss();
    const job = await this.deps.opsRepository.getJobById(jobId);
    if (!job) {
      await this.clearDeletedJob(boss, jobId);
      return;
    }
    await this.syncJob(boss, job);
  }

  private async syncJob(boss: PgBoss, job: Job): Promise<void> {
    const nowMs = currentTimeMs();
    const signature = this.scheduleSignature(job, nowMs);
    if (this.scheduleSignatures.get(job.id) === signature) return;
    await this.clearBossSchedule(boss, job.id);
    if (job.status !== 'active') {
      this.scheduleSignatures.set(job.id, signature);
      return;
    }
    const scheduleValidationError = validateScheduleConfig(job);
    if (scheduleValidationError) {
      logger.warn(
        { jobId: job.id, scheduleValidationError },
        'Dead-lettering scheduler job with invalid schedule config',
      );
      await this.deps.opsRepository.updateJob(job.id, {
        status: 'dead_lettered',
        pause_reason: scheduleValidationError,
        next_run: null,
        lease_run_id: null,
        lease_expires_at: null,
      });
      this.scheduleSignatures.delete(job.id);
      this.deps.onSchedulerChanged?.(job.id);
      return;
    }
    this.scheduleSignatures.set(job.id, signature);
    if (job.schedule_type === 'manual') return;
    if (job.schedule_type === 'cron') {
      await boss.schedule(
        SCHEDULER_QUEUE,
        job.schedule_value,
        { jobId: job.id },
        {
          key: pgBossJobKey(job.id),
          tz: TIMEZONE,
          group: { id: pgBossGroupId(job.workspace_key) },
          singletonKey: pgBossJobKey(job.id),
          retryLimit: 0,
        },
      );
      return;
    }
    if (!isRunnableScheduledJob(job) || !job.next_run) return;
    const missedWindow = schedulerJobStaleness(job, nowMs) === 'missed_window';
    const startAfter = missedWindow ? toIso(nowMs) : job.next_run;
    if (missedWindow) {
      logger.warn(
        { jobId: job.id, nextRun: job.next_run, startAfter },
        'Re-enqueueing stale once scheduler job after missed fire window',
      );
    }
    const pgBossStartAt = pgBossStartAfter(startAfter);
    await boss.send(
      SCHEDULER_QUEUE,
      {
        jobId: job.id,
        scheduledFor: job.next_run,
      },
      {
        id: pgBossSendId(job.id, scheduleSlotForJob(job)),
        startAfter: pgBossStartAt,
        group: { id: pgBossGroupId(job.workspace_key) },
        retryLimit: 0,
      },
    );
  }

  private scheduleSignature(job: Job, nowMs: number): string {
    return JSON.stringify({
      id: job.id,
      status: job.status,
      scheduleType: job.schedule_type,
      scheduleValue: job.schedule_value,
      nextRun: job.schedule_type === 'cron' ? null : job.next_run,
      staleOnceRequeueBucket: staleOnceRequeueBucket(
        job,
        nowMs,
        STALE_ONCE_REENQUEUE_THROTTLE_MS,
      ),
      workspaceKey: job.workspace_key,
    });
  }

  private async clearDeletedJob(boss: PgBoss, jobId: string): Promise<void> {
    await this.clearBossSchedule(boss, jobId);
    this.scheduleSignatures.delete(jobId);
  }

  private async clearBossSchedule(boss: PgBoss, jobId: string): Promise<void> {
    const jobKey = pgBossJobKey(jobId);
    await Promise.allSettled([
      boss.unschedule(SCHEDULER_QUEUE, jobKey),
      boss.deleteJob(SCHEDULER_QUEUE, pgBossSendId(jobId, 'once')),
      boss.deleteJob(SCHEDULER_QUEUE, pgBossSendId(jobId, 'interval')),
    ]);
  }

  private async processBossJobs(
    jobs: PgBossJob<SchedulerDispatchPayload>[],
  ): Promise<void> {
    for (const bossJob of jobs) {
      const payload = bossJob.data;
      if (!payload?.jobId) continue;
      const current = await this.deps.opsRepository.getJobById(payload.jobId);
      if (!current) continue;
      // Capability-matched dispatch (fleet only): an ineligible worker must not
      // claim. Requeue its delivery and skip runJob so no retry budget burns.
      if (await this.requeuedIneligibleDelivery(current, payload)) continue;
      const queueJid = schedulerQueueJid(current.workspace_key, current.id);
      const releaseSlot = await tryAcquireRunSlot(current.workspace_key);
      if (!releaseSlot) {
        await this.requeueRunSlotBlockedDelivery(current, payload);
        continue;
      }
      try {
        await this.callbacks.runJob(current, this.deps, queueJid, payload);
      } catch (err) {
        logger.warn(
          { err, jobId: current.id, queueJid },
          'pg-boss scheduler run crashed before completion',
        );
      } finally {
        releaseSlot?.();
      }
      this.requestSync();
    }
  }

  private async requeueRunSlotBlockedDelivery(
    job: Job,
    payload: SchedulerDispatchPayload,
  ): Promise<void> {
    const startAfter = new Date(currentTimeMs() + runSlotRequeueDelayMs());
    try {
      await this.requireBoss().send(
        SCHEDULER_QUEUE,
        { ...payload, jobId: job.id },
        {
          id: randomUUID(),
          startAfter,
          group: { id: pgBossGroupId(job.workspace_key) },
          retryLimit: 0,
        },
      );
      logger.info(
        { jobId: job.id, startAfter: startAfter.toISOString() },
        'Requeued scheduler delivery while run slot capacity is full',
      );
    } catch (err) {
      logger.warn(
        { err, jobId: job.id },
        'Failed to requeue scheduler delivery blocked on run slot capacity',
      );
      throw err;
    }
  }

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
  private async requeuedIneligibleDelivery(
    job: Job,
    payload: SchedulerDispatchPayload,
  ): Promise<boolean> {
    if (getDeploymentMode() !== 'fleet') return false;
    const decision = await decideCapabilityDispatch(
      {
        deploymentMode: 'fleet',
        skills: this.deps.getSkillRepository?.(),
        runtimeDependencies:
          getRuntimeStorage().repositories.runtimeDependencies,
        workerAdvertisedCapabilities: async () => {
          const workerInstanceId = currentWorkerInstanceId();
          if (!workerInstanceId) return null;
          const worker =
            await getWorkerCoordinationRepository().getWorker(workerInstanceId);
          return worker?.capabilities ?? null;
        },
        warn: (context, message) => logger.warn(context, message),
      },
      job,
    );
    // Persist the resolved required set durably for observability/readiness.
    await this.persistRequiredCapabilities(job, decision.requiredCapabilities);
    if (decision.outcome !== 'ineligible') return false;

    const startAfter = new Date(currentTimeMs() + ineligibleRequeueDelayMs());
    try {
      await this.requireBoss().send(
        SCHEDULER_QUEUE,
        { ...payload, jobId: job.id },
        {
          id: randomUUID(),
          startAfter,
          group: { id: pgBossGroupId(job.workspace_key) },
          retryLimit: 0,
        },
      );
    } catch (err) {
      logger.warn(
        { err, jobId: job.id },
        'Failed to requeue ineligible scheduler delivery',
      );
      throw err;
    }
    logger.info(
      {
        jobId: job.id,
        requiredCapabilities: decision.requiredCapabilities,
        missingCapabilities: decision.missingCapabilities,
        startAfter: startAfter.toISOString(),
      },
      'Requeued ineligible scheduler delivery without consuming retry budget',
    );
    return true;
  }

  /** Persist the resolved required set onto the job when it changed. */
  private async persistRequiredCapabilities(
    job: Job,
    resolved: readonly string[],
  ): Promise<void> {
    if (!requiredCapabilitiesChanged(job.required_capabilities, resolved)) {
      return;
    }
    try {
      await this.deps.opsRepository.updateJob(job.id, {
        required_capabilities: [...resolved],
      });
    } catch (err) {
      logger.warn(
        { err, jobId: job.id },
        'Failed to persist resolved required capabilities',
      );
    }
  }

  private requireBoss(): PgBoss {
    if (!this.boss) throw new Error('pg-boss scheduler is not running');
    return this.boss;
  }
}

export async function ensureSchedulerQueues(boss: PgBoss): Promise<void> {
  await boss.createQueue(SCHEDULER_QUEUE_DEAD_LETTER, {
    policy: 'standard',
    retentionSeconds: 14 * 24 * 60 * 60,
  });
  await boss.createQueue(SCHEDULER_QUEUE, {
    policy: 'standard',
    retryLimit: 0,
    deadLetter: SCHEDULER_QUEUE_DEAD_LETTER,
    retentionSeconds: 14 * 24 * 60 * 60,
  });
}

export async function enqueueSchedulerTriggerDelivery(input: {
  boss: PgBoss;
  opsRepository: SchedulerDependencies['opsRepository'];
  jobId: string;
  triggerId: string;
  runId?: string;
}): Promise<void> {
  const [job, trigger] = await Promise.all([
    input.opsRepository.getJobById(input.jobId),
    getRuntimeControlRepository().getTriggerById(input.triggerId),
  ]);
  if (!job) throw new Error(`Job not found: ${input.jobId}`);
  if (!trigger) throw new Error(`Trigger not found: ${input.triggerId}`);
  await input.boss.send(
    SCHEDULER_QUEUE,
    {
      jobId: input.jobId,
      runId: input.runId,
      triggerId: input.triggerId,
      scheduledFor: trigger.requestedAt,
    },
    {
      id: pgBossSendId(input.jobId, `trigger:${input.triggerId}`),
      group: { id: pgBossGroupId(job.workspace_key) },
      retryLimit: 0,
    },
  );
}

function runSlotRequeueDelayMs(random: () => number = Math.random): number {
  return 1_000 + Math.floor(random() * 4_000);
}
