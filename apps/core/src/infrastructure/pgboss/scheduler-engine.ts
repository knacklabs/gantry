import { createHash } from 'node:crypto';
import { PgBoss, type Job as PgBossJob } from 'pg-boss';

import {
  STORAGE_POSTGRES_SCHEMA,
  STORAGE_POSTGRES_URL,
  TIMEZONE,
  getRuntimeQueueConfig,
} from '../../config/index.js';
import { logger } from '../logging/logger.js';
import type { Job } from '../../domain/types.js';
import type { ReleasedStaleJobLease } from '../../domain/repositories/ops-repo.js';
import { getRuntimeControlRepository } from '../../adapters/storage/postgres/runtime-store.js';
import { acquireRunSlot } from '../../jobs/concurrency.js';
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
}

function pgBossKey(kind: string, value: string): string {
  return `${PGBOSS_KEY_PREFIX}.${kind}.${Buffer.from(value).toString('base64url')}`;
}

function pgBossGroupId(groupScope: string): string {
  return pgBossKey('group', groupScope);
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

function schedulerQueueJid(groupScope: string, jobId?: string): string {
  return `__scheduler__:${groupScope}${jobId ? `:${jobId}` : ''}`;
}

export class PgBossSchedulerEngine {
  private boss: PgBoss | null = null;
  private ready = false;
  private syncInFlight: Promise<void> | null = null;
  private fullSyncRequested = false;
  private readonly pendingJobSyncs = new Set<string>();
  private readonly scheduleSignatures = new Map<string, string>();
  private maintenanceTimer: ReturnType<typeof setInterval> | null = null;

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
    await this.releaseInterruptedStartupLeases();
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
    const boss = this.requireBoss();
    const [job, trigger] = await Promise.all([
      this.deps.opsRepository.getJobById(jobId),
      getRuntimeControlRepository().getTriggerById(triggerId),
    ]);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    if (!trigger) throw new Error(`Trigger not found: ${triggerId}`);
    await boss.send(
      SCHEDULER_QUEUE,
      {
        jobId,
        runId: options?.runId,
        triggerId,
        scheduledFor: trigger.requestedAt,
      },
      {
        id: pgBossSendId(jobId, `trigger:${triggerId}`),
        group: { id: pgBossGroupId(job.group_scope) },
        retryLimit: 0,
      },
    );
  }

  private async ensureQueues(): Promise<void> {
    const boss = this.requireBoss();
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
    for (const jobId of this.scheduleSignatures.keys()) {
      if (!liveJobIds.has(jobId)) await this.clearDeletedJob(boss, jobId);
    }
  }

  private async releaseInterruptedStartupLeases(): Promise<void> {
    const releaseInterrupted =
      this.deps.opsRepository.releaseInterruptedJobLeases;
    if (!releaseInterrupted) return;
    const released = await releaseInterrupted.call(this.deps.opsRepository);
    if (released.length === 0) return;
    logger.warn(
      {
        count: released.length,
        releases: released.map((release) => ({
          jobId: release.jobId,
          runId: release.runId,
          runTimedOut: release.runTimedOut,
          reason: release.reason,
        })),
      },
      'Released interrupted scheduler leases after runtime startup',
    );
    await this.callbacks.handleReleasedStaleLeases?.(released, this.deps);
    this.scheduleSignatures.clear();
    this.deps.onSchedulerChanged?.();
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
          group: { id: pgBossGroupId(job.group_scope) },
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
        group: { id: pgBossGroupId(job.group_scope) },
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
      groupScope: job.group_scope,
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
      const queueJid = schedulerQueueJid(current.group_scope, current.id);
      const releaseSlot = await acquireRunSlot(current.group_scope);
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

  private requireBoss(): PgBoss {
    if (!this.boss) throw new Error('pg-boss scheduler is not running');
    return this.boss;
  }
}
