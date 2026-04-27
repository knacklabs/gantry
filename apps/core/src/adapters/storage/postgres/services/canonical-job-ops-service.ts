import { randomUUID } from 'node:crypto';

import type {
  Job,
  JobEvent,
  JobRun,
} from '../../../../domain/repositories/domain-types.js';
import type { JobUpsertInput } from '../../../../domain/repositories/ops-repo.js';
import { nowIso as currentIso } from '../../../../infrastructure/time/datetime.js';
import {
  agentIdForFolder,
  json,
  parseJson,
} from '../repositories/canonical-graph-repository.postgres.js';
import type {
  CanonicalJobEventRecord,
  CanonicalJobRecord,
  CanonicalRunRecord,
  JobRecordInput,
  PostgresCanonicalJobRepository,
} from '../repositories/canonical-job-repository.postgres.js';

type JobRecordSource = Omit<JobUpsertInput, 'id'> | JobUpsertInput | Job;

export class CanonicalJobOpsService {
  constructor(private readonly repository: PostgresCanonicalJobRepository) {}

  async upsertJob(job: JobUpsertInput): Promise<{ created: boolean }> {
    const now = currentIso();
    const existing = await this.getJobById(job.id);
    const status =
      existing?.status === 'running' || existing?.status === 'dead_lettered'
        ? existing.status
        : job.status || 'active';
    await this.repository.upsertJob(
      this.toRecordInput(job.id, agentIdForFolder(job.group_scope), {
        name: job.name,
        prompt: job.prompt,
        model: job.model,
        schedule_type: job.schedule_type,
        schedule_value: job.schedule_value,
        status,
        linked_sessions: job.linked_sessions,
        session_id: job.session_id,
        thread_id: job.thread_id,
        group_scope: job.group_scope,
        created_by: job.created_by,
        script: job.script,
        cleanup_after_ms: job.cleanup_after_ms,
        timeout_ms: job.timeout_ms,
        max_retries: job.max_retries,
        retry_backoff_ms: job.retry_backoff_ms,
        max_consecutive_failures: job.max_consecutive_failures,
        consecutive_failures: job.consecutive_failures,
        execution_mode: job.execution_mode,
        lease_run_id: job.lease_run_id,
        lease_expires_at: job.lease_expires_at,
        next_run: job.next_run,
        last_run: job.last_run,
        silent: job.silent,
        pause_reason: job.pause_reason,
        created_at: job.created_at || now,
        updated_at: job.updated_at || now,
      }),
    );
    return { created: !existing };
  }

  async getJobById(id: string): Promise<Job | undefined> {
    const row = await this.repository.findJobById(id);
    return row ? this.rowToJob(row) : undefined;
  }

  async getAllJobs(): Promise<Job[]> {
    const rows = await this.repository.listJobs();
    return rows.map((row) => this.rowToJob(row));
  }

  async updateJob(id: string, updates: Partial<Job>): Promise<void> {
    const current = await this.getJobById(id);
    if (!current) return;
    const next = { ...current, ...updates };
    await this.repository.updateJob(
      id,
      this.toRecordInput(id, agentIdForFolder(next.group_scope), {
        ...next,
        updated_at: updates.updated_at ?? currentIso(),
      }),
    );
  }

  async deleteJob(id: string): Promise<void> {
    await this.repository.deleteJob(id);
  }

  async deleteExpiredCompletedOneTimeJobs(
    nowIso: string = currentIso(),
  ): Promise<number> {
    const nowMs = Date.parse(nowIso);
    const jobs = await this.getAllJobs();
    const expired = jobs.filter((job) => {
      if (
        job.schedule_type !== 'once' ||
        !['completed', 'dead_lettered'].includes(job.status)
      ) {
        return false;
      }
      const basis = Date.parse(
        job.last_run || job.updated_at || job.created_at,
      );
      return (
        job.cleanup_after_ms === 0 || nowMs - basis >= job.cleanup_after_ms
      );
    });
    for (const job of expired) await this.deleteJob(job.id);
    return expired.length;
  }

  async claimDueJobRunStart(input: {
    jobId: string;
    runId: string;
    scheduledFor: string;
    startedAt: string;
    retryCount: number;
    leaseExpiresAt: string;
    requireNextRun?: boolean;
  }): Promise<boolean> {
    return this.repository.claimDueRunStart({
      jobId: input.jobId,
      run: {
        run_id: input.runId,
        job_id: input.jobId,
        scheduled_for: input.scheduledFor,
        started_at: input.startedAt,
        ended_at: null,
        status: 'running',
        result_summary: null,
        error_summary: null,
        retry_count: input.retryCount,
        notified_at: null,
      },
      leaseExpiresAt: input.leaseExpiresAt,
      requireNextRun: input.requireNextRun,
    });
  }

  async releaseStaleJobLeases(nowIso: string = currentIso()): Promise<number> {
    return this.repository.releaseStaleLeases(nowIso);
  }

  async createJobRun(run: JobRun): Promise<boolean> {
    return this.repository.insertRun(run);
  }

  async getRecentJobRuns(limit = 200): Promise<JobRun[]> {
    return this.listJobRuns(undefined, limit);
  }

  async completeJobRun(
    runId: string,
    status: JobRun['status'],
    resultSummary: string | null = null,
    errorSummary: string | null = null,
  ): Promise<void> {
    await this.repository.updateRunCompletion(runId, {
      status,
      endedAt: currentIso(),
      resultSummary,
      errorSummary,
    });
  }

  async markJobRunNotified(_runId: string): Promise<void> {}

  async getJobRunById(runId: string): Promise<JobRun | undefined> {
    const row = await this.repository.findRunById(runId);
    return row ? this.mapRun(row) : undefined;
  }

  async listJobRuns(jobId?: string, limit = 50): Promise<JobRun[]> {
    const rows = await this.repository.listRuns(jobId, limit);
    return rows.map((row) => this.mapRun(row));
  }

  async listDeadLetterRuns(limit = 50): Promise<JobRun[]> {
    const rows = await this.repository.listDeadLetterRuns(limit);
    return rows.map((row) => this.mapRun(row));
  }

  async addJobEvent(event: Omit<JobEvent, 'id'>): Promise<void> {
    const runId = event.run_id || `run:${event.job_id}`;
    await this.repository.insertRun({
      run_id: runId,
      job_id: event.job_id,
      scheduled_for: event.created_at,
      started_at: event.created_at,
      ended_at: null,
      status: 'running',
      result_summary: null,
      error_summary: null,
      retry_count: 0,
      notified_at: null,
    });
    await this.repository.insertEvent({
      id: randomUUID(),
      runId,
      type: event.event_type,
      payloadJson: json(event),
      createdAt: event.created_at,
    });
  }

  async listRecentJobEvents(
    limit = 200,
    filters?: { job_id?: string; run_id?: string; event_type?: string },
  ): Promise<JobEvent[]> {
    const rows = await this.repository.listEvents(limit, {
      runId: filters?.run_id,
      eventType: filters?.event_type,
    });
    return rows
      .map((row, index) => this.mapEvent(row, index, filters?.job_id))
      .filter((event) => !filters?.job_id || event.job_id === filters.job_id);
  }

  private rowToJob(row: CanonicalJobRecord): Job {
    const schedule = parseJson<{ type?: string; value?: string }>(
      row.scheduleJson,
      {},
    );
    const target = parseJson<Record<string, unknown>>(row.targetJson, {});
    return {
      id: row.id,
      name: row.name,
      prompt: row.prompt,
      model: row.modelOverride,
      script: (target.script as string | null | undefined) ?? null,
      schedule_type: (schedule.type as Job['schedule_type']) || 'manual',
      schedule_value: schedule.value || '',
      status: row.status as Job['status'],
      linked_sessions: (target.linkedSessions as string[] | undefined) ?? [],
      session_id: (target.sessionId as string | null | undefined) ?? null,
      thread_id: (target.threadId as string | null | undefined) ?? null,
      group_scope:
        (target.groupScope as string | undefined) ||
        row.agentId?.replace(/^agent:/, '') ||
        'system',
      created_by: (target.createdBy as Job['created_by']) || 'agent',
      created_at: row.createdAt,
      updated_at: row.updatedAt,
      next_run: row.nextRunAt,
      last_run: row.lastRunAt,
      silent: row.silent,
      cleanup_after_ms: Number(target.cleanupAfterMs ?? 86400000),
      timeout_ms: row.timeoutMs,
      max_retries: row.maxRetries,
      retry_backoff_ms: row.retryBackoffMs,
      max_consecutive_failures: Number(target.maxConsecutiveFailures ?? 5),
      consecutive_failures: Number(target.consecutiveFailures ?? 0),
      execution_mode: row.executionMode as Job['execution_mode'],
      lease_run_id: row.leaseRunId,
      lease_expires_at: row.leaseExpiresAt,
      pause_reason: (target.pauseReason as string | null | undefined) ?? null,
    };
  }

  private toRecordInput(
    id: string,
    agentId: string,
    job: JobRecordSource,
  ): JobRecordInput {
    const now = currentIso();
    return {
      id,
      agentId,
      name: job.name,
      prompt: job.prompt,
      modelOverride: job.model || null,
      scheduleJson: json({
        type: job.schedule_type,
        value: job.schedule_value,
      }),
      status: job.status || 'active',
      executionMode: job.execution_mode || 'parallel',
      targetJson: json({
        linkedSessions: job.linked_sessions,
        sessionId: job.session_id ?? null,
        threadId: job.thread_id ?? null,
        groupScope: job.group_scope,
        createdBy: job.created_by || 'agent',
        script: job.script ?? null,
        cleanupAfterMs: job.cleanup_after_ms ?? 86400000,
        maxConsecutiveFailures: job.max_consecutive_failures ?? 5,
        consecutiveFailures: job.consecutive_failures ?? 0,
        pauseReason: job.pause_reason ?? null,
      }),
      silent: Boolean(job.silent),
      timeoutMs: job.timeout_ms ?? 300000,
      maxRetries: job.max_retries ?? 3,
      retryBackoffMs: job.retry_backoff_ms ?? 5000,
      nextRunAt: job.next_run ?? null,
      lastRunAt: job.last_run ?? null,
      leaseRunId: job.lease_run_id ?? null,
      leaseExpiresAt: job.lease_expires_at ?? null,
      createdAt: job.created_at || now,
      updatedAt: job.updated_at || now,
    };
  }

  private mapRun(row: CanonicalRunRecord): JobRun {
    return {
      run_id: row.id,
      job_id: row.jobId || '',
      scheduled_for: row.createdAt,
      started_at: row.startedAt || row.createdAt,
      ended_at: row.endedAt,
      status: row.status as JobRun['status'],
      result_summary: row.resultSummary,
      error_summary: row.errorSummary,
      retry_count: 0,
      notified_at: null,
    };
  }

  private mapEvent(
    row: CanonicalJobEventRecord,
    index: number,
    fallbackJobId?: string,
  ): JobEvent {
    const payload = parseJson<Partial<JobEvent>>(row.payloadJson, {});
    return {
      id: index + 1,
      job_id: payload.job_id || fallbackJobId || '',
      run_id: row.runId,
      event_type: row.type,
      payload: payload.payload ?? row.payloadJson,
      created_at: row.createdAt,
    };
  }
}
