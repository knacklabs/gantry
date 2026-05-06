import { PgBoss, type Job as PgBossJob } from 'pg-boss';

import {
  STORAGE_POSTGRES_SCHEMA,
  STORAGE_POSTGRES_URL,
  TIMEZONE,
} from '../../config/index.js';
import { logger } from '../logging/logger.js';
import type { Job, JobExecutionMode } from '../../domain/types.js';
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
import {
  nowMs as currentTimeMs,
  toIso,
} from '../../infrastructure/time/datetime.js';

const SCHEDULER_QUEUE_PARALLEL = 'myclaw.jobs.parallel';
const SCHEDULER_QUEUE_SERIALIZED = 'myclaw.jobs.serialized';
const SCHEDULER_QUEUE_DEAD_LETTER = 'myclaw.jobs.dead_letter';
const PGBOSS_KEY_PREFIX = 'myclaw';
const STALE_ONCE_REENQUEUE_THROTTLE_MS = 60_000;

interface PgBossSchedulerCallbacks {
  registerSystemJobs: (deps: SchedulerDependencies) => Promise<void>;
  runJob: (
    job: Job,
    deps: SchedulerDependencies,
    queueJid: string,
    executionModeHint?: JobExecutionMode,
    dispatch?: SchedulerDispatchPayload,
  ) => Promise<void>;
  sweepCompletedOneTimeJobs: (deps: SchedulerDependencies) => Promise<boolean>;
}

function jobQueueName(job: Pick<Job, 'execution_mode'>): string {
  return job.execution_mode === 'serialized'
    ? SCHEDULER_QUEUE_SERIALIZED
    : SCHEDULER_QUEUE_PARALLEL;
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
  return pgBossKey('send', `${jobId}:${slot}`);
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
      application_name: `myclaw-${STORAGE_POSTGRES_SCHEMA}-jobs`,
    });
    boss.on('error', (err) => {
      logger.error({ err }, 'pg-boss scheduler error');
    });
    await boss.start();
    this.boss = boss;
    await this.ensureQueues();
    await boss.work<SchedulerDispatchPayload>(
      SCHEDULER_QUEUE_PARALLEL,
      {
        batchSize: 1,
        pollingIntervalSeconds: 1,
        localConcurrency: 4,
      },
      (jobs) => this.processBossJobs(jobs, 'parallel'),
    );
    await boss.work<SchedulerDispatchPayload>(
      SCHEDULER_QUEUE_SERIALIZED,
      {
        batchSize: 1,
        pollingIntervalSeconds: 1,
        localConcurrency: 4,
        groupConcurrency: 1,
      },
      (jobs) => this.processBossJobs(jobs, 'serialized'),
    );
    await this.syncAllJobs();
    this.ready = true;
  }

  async stop(): Promise<void> {
    const boss = this.boss;
    this.ready = false;
    this.boss = null;
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
      jobQueueName(job),
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
    await boss.createQueue(SCHEDULER_QUEUE_PARALLEL, {
      policy: 'standard',
      retryLimit: 0,
      deadLetter: SCHEDULER_QUEUE_DEAD_LETTER,
      retentionSeconds: 14 * 24 * 60 * 60,
    });
    await boss.createQueue(SCHEDULER_QUEUE_SERIALIZED, {
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
    if (released > 0) {
      logger.warn({ count: released }, 'Released stale scheduler leases');
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
        jobQueueName(job),
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
    await boss.send(
      jobQueueName(job),
      {
        jobId: job.id,
        scheduledFor: job.next_run,
      },
      {
        id: pgBossSendId(job.id, scheduleSlotForJob(job)),
        startAfter,
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
      executionMode: job.execution_mode,
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
      boss.unschedule(SCHEDULER_QUEUE_PARALLEL, jobKey),
      boss.unschedule(SCHEDULER_QUEUE_SERIALIZED, jobKey),
      boss.deleteJob(SCHEDULER_QUEUE_PARALLEL, pgBossSendId(jobId, 'once')),
      boss.deleteJob(SCHEDULER_QUEUE_SERIALIZED, pgBossSendId(jobId, 'once')),
      boss.deleteJob(SCHEDULER_QUEUE_PARALLEL, pgBossSendId(jobId, 'interval')),
      boss.deleteJob(
        SCHEDULER_QUEUE_SERIALIZED,
        pgBossSendId(jobId, 'interval'),
      ),
    ]);
  }

  private async processBossJobs(
    jobs: PgBossJob<SchedulerDispatchPayload>[],
    mode: JobExecutionMode,
  ): Promise<void> {
    for (const bossJob of jobs) {
      const payload = bossJob.data;
      if (!payload?.jobId) continue;
      const current = await this.deps.opsRepository.getJobById(payload.jobId);
      if (!current) continue;
      const queueJid =
        mode === 'serialized'
          ? schedulerQueueJid(current.group_scope)
          : schedulerQueueJid(current.group_scope, current.id);
      const releaseSlot = acquireRunSlot(current.group_scope, mode);
      try {
        await this.callbacks.runJob(
          current,
          this.deps,
          queueJid,
          mode,
          payload,
        );
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
