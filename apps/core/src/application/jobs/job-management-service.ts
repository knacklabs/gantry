import { RUNTIME_EVENT_TYPES } from '../../domain/events/runtime-event-types.js';
import { ApplicationError } from '../common/application-error.js';
import type { Clock } from '../common/clock.js';
import { assertJobBelongsToApp, resolveJobRuntimeAppId } from './job-access.js';
import { isVisibleJob } from './job-list-filters.js';
import {
  assertSchedulerJobAccess,
  normalizeOptional,
  resolveLinkedSessions,
  validateSchedulerUpdate,
} from './job-management-access.js';
import { createManagedJob } from './job-management-create.js';
import { requireJobExtraToolApproval } from './job-extra-tool-approval.js';
import {
  buildJobUpdates,
  encodeTriggerRequester,
  normalizeExecutionMode,
  normalizeScheduleType,
  resolveLimit,
} from './job-management-helpers.js';
import type {
  Job,
  JobEvent,
  AppSessionRecord,
  JobControlPort,
  JobManagementServiceDeps,
  JobRun,
  JobTriggerQueuePort,
  JobUpsertInput,
  JobKind,
  RuntimeEventPublisherPort,
  SchedulerJobAccess,
  SchedulerRunNowInput,
  JobUpdatePatch,
  CreateManagedJobInput,
  UpsertJobFromIpcInput,
} from './job-management-types.js';
import {
  resolveOptionalJobModel,
  resolveRequestedJobModel,
} from './job-model-selection.js';
import {
  agentIdForJobGroupScope,
  assertJobExtraToolsAllowedForTarget,
  normalizeJobExtraTools,
  resolveAgentToolBindings,
} from './job-tool-policy.js';
import { runSchedulerJobNowFromMcp } from './job-management-run-now.js';

const DEFAULT_RUN_LIMIT = 50;
const DEFAULT_JOB_LIST_LIMIT = 100;
const MAX_JOB_LIST_LIMIT = 500;
const DEFAULT_EVENT_LIMIT = 200;
const DEFAULT_DEAD_LETTER_LIMIT = 50;
const TRIGGER_POLL_INTERVAL_MS = 2_000;

export class JobManagementService {
  constructor(private readonly deps: JobManagementServiceDeps) {}

  async createJob(input: CreateManagedJobInput) {
    return createManagedJob(this.deps, input);
  }

  async upsertJobFromIpc(
    input: UpsertJobFromIpcInput,
  ): Promise<{ jobId: string; created: boolean; modelAlias?: string }> {
    const access = input.access;
    const name = input.name.trim();
    const prompt = input.prompt.trim();
    if (!name || !prompt) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'scheduler_upsert_job requires name and prompt.',
      );
    }
    if (input.scheduleType === undefined || input.scheduleType === null) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'scheduler_upsert_job requires scheduleType.',
      );
    }
    const scheduleType = normalizeScheduleType(input.scheduleType);
    if (scheduleType === 'manual') {
      throw new ApplicationError(
        'INVALID_SCHEDULE',
        'Unsupported schedule type.',
      );
    }
    const schedule = this.deps.schedulePlanner.planInitial({
      scheduleType,
      scheduleValue: input.scheduleValue,
    });
    const modelAlias = resolveRequestedJobModel(
      input.modelAlias,
      input.modelProfileId,
    );
    const groupScope = (input.groupScope || access.sourceGroup).trim();
    if (groupScope !== access.sourceGroup) {
      throw new ApplicationError(
        'FORBIDDEN',
        'Scheduler jobs cannot be created outside the source group.',
      );
    }

    const linkedSessions = resolveLinkedSessions(input, access);
    const authThreadId = normalizeOptional(input.access.authThreadId);
    const payloadThreadId = normalizeOptional(input.threadId);
    if (payloadThreadId && payloadThreadId !== authThreadId) {
      throw new ApplicationError(
        'FORBIDDEN',
        'threadId payload does not match authenticated thread binding.',
      );
    }

    const requestedJobId = normalizeOptional(input.jobId);
    let id = this.deps.schedulePlanner.createJobId({
      name,
      prompt,
      scheduleType,
      scheduleValue: input.scheduleValue,
      groupScope,
    });
    let existingJob: Job | undefined;
    if (requestedJobId) {
      existingJob = await this.deps.ops.getJobById(requestedJobId);
      if (existingJob) assertSchedulerJobAccess(existingJob, access);
      id = requestedJobId;
    }
    existingJob ??= await this.deps.ops.getJobById(id);
    if (existingJob) assertSchedulerJobAccess(existingJob, access);
    const allowedTools =
      input.allowedTools === undefined
        ? (existingJob?.capability_policy?.allowed_tools ?? [])
        : normalizeJobExtraTools(input.allowedTools);
    const inheritedTools = await resolveAgentToolBindings({
      repository: this.deps.toolRepository,
      appId: 'default',
      agentId: agentIdForJobGroupScope(groupScope),
    });
    assertJobExtraToolsAllowedForTarget({
      rules: allowedTools,
      inheritedTools,
    });
    await requireJobExtraToolApproval({
      deps: this.deps,
      jobId: id,
      jobName: name,
      appId: 'default',
      groupScope,
      allowedTools,
      existingJobExtraTools:
        existingJob?.capability_policy?.allowed_tools ?? [],
      operation: existingJob ? 'update' : 'create',
    });

    const job: JobUpsertInput = {
      id,
      name,
      prompt,
      model: modelAlias ?? null,
      script: null,
      schedule_type: scheduleType,
      schedule_value: input.scheduleValue.trim(),
      linked_sessions: linkedSessions,
      session_id: null,
      thread_id: authThreadId ?? payloadThreadId ?? null,
      group_scope: groupScope,
      created_by: input.createdBy === 'human' ? 'human' : 'agent',
      status: 'active',
      next_run: schedule.nextRun,
      silent: input.silent === true,
      cleanup_after_ms: input.cleanupAfterMs,
      timeout_ms: input.timeoutMs,
      max_retries: input.maxRetries,
      retry_backoff_ms: input.retryBackoffMs,
      max_consecutive_failures: input.maxConsecutiveFailures,
      execution_mode: normalizeExecutionMode(
        input.executionMode,
        input.serialize,
      ),
      capability_policy: { allowed_tools: allowedTools },
    };
    const result = await this.deps.ops.upsertJob(job);
    this.deps.scheduler.requestSchedulerSync(id);
    return { jobId: id, created: result.created, modelAlias };
  }

  async listJobs(input: {
    appId?: string;
    access?: SchedulerJobAccess;
    statuses?: string[];
    groupScope?: string;
    agentId?: string;
    kind?: JobKind;
    conversationJid?: string;
    limit?: number;
  }): Promise<{ jobs: Job[] }> {
    const queryGroupScope = input.access
      ? input.access.sourceGroup
      : input.groupScope;
    const jobs = await this.deps.ops.listJobs({
      appId: input.appId,
      statuses: input.statuses,
      groupScope: queryGroupScope,
      threadId: undefined,
      agentId: input.agentId,
      kind: input.kind,
      conversationJid: input.access
        ? input.access.originConversationJid
        : input.conversationJid,
      limit: Math.min(
        resolveLimit(input.limit, DEFAULT_JOB_LIST_LIMIT),
        MAX_JOB_LIST_LIMIT,
      ),
    });
    return {
      jobs: jobs.filter((job) => isVisibleJob(job, input)),
    };
  }

  async getJob(input: {
    jobId: string;
    appId?: string;
    access?: SchedulerJobAccess;
  }): Promise<{ job: Job | null }> {
    const job = await this.deps.ops.getJobById(input.jobId);
    if (!job) return { job: null };
    if (input.appId) assertJobBelongsToApp(job, input.appId);
    if (input.access) assertSchedulerJobAccess(job, input.access);
    return { job };
  }

  async updateJob(input: {
    jobId: string;
    appId?: string;
    access?: SchedulerJobAccess;
    patch: JobUpdatePatch;
  }): Promise<{ job: Job }> {
    const job = await this.requireJob(input.jobId);
    this.assertAccess(job, input);
    const patch = { ...input.patch };
    if (typeof patch.model === 'string') {
      patch.model = resolveOptionalJobModel(patch.model);
    }
    const allowedTools =
      patch.allowedTools === undefined
        ? undefined
        : normalizeJobExtraTools(patch.allowedTools);
    if (allowedTools) {
      const targetGroupScope = patch.groupScope ?? job.group_scope;
      const inheritedTools = await resolveAgentToolBindings({
        repository: this.deps.toolRepository,
        appId: resolveJobRuntimeAppId(job),
        agentId: agentIdForJobGroupScope(targetGroupScope),
      });
      assertJobExtraToolsAllowedForTarget({
        rules: allowedTools,
        inheritedTools,
      });
      await requireJobExtraToolApproval({
        deps: this.deps,
        jobId: job.id,
        jobName: patch.name ?? job.name,
        appId: resolveJobRuntimeAppId(job),
        groupScope: targetGroupScope,
        allowedTools,
        existingJobExtraTools: job.capability_policy?.allowed_tools ?? [],
        operation: 'update',
      });
    }
    const updates = buildJobUpdates(
      job,
      {
        ...patch,
        ...(allowedTools ? { allowedTools } : {}),
      },
      this.deps.schedulePlanner,
      this.clock(),
    );
    if (input.access) {
      validateSchedulerUpdate(job, updates, input.access);
    }
    if (Object.keys(updates).length === 0) return { job };
    await this.deps.ops.updateJob(job.id, updates);
    this.deps.scheduler.requestSchedulerSync(job.id);
    return { job: { ...job, ...updates } };
  }

  async deleteJob(input: {
    jobId: string;
    appId?: string;
    access?: SchedulerJobAccess;
  }): Promise<{ deleted: true }> {
    const job = await this.requireJob(input.jobId);
    this.assertAccess(job, input);
    await this.deps.ops.deleteJob(job.id);
    this.deps.scheduler.requestSchedulerSync(job.id);
    return { deleted: true };
  }

  async pauseJob(input: {
    jobId: string;
    appId?: string;
    access?: SchedulerJobAccess;
    reason?: string;
  }): Promise<{ paused: true }> {
    const job = await this.requireJob(input.jobId);
    this.assertAccess(job, input);
    await this.deps.ops.updateJob(job.id, {
      status: 'paused',
      pause_reason: input.reason?.trim() || 'Paused by SDK',
      next_run: null,
    });
    this.deps.scheduler.requestSchedulerSync(job.id);
    return { paused: true };
  }

  async resumeJob(input: {
    jobId: string;
    appId?: string;
    access?: SchedulerJobAccess;
    invalidSchedulePolicy?: 'resume_now' | 'dead_letter';
  }): Promise<{ resumed: true; job: Job }> {
    const job = await this.requireJob(input.jobId);
    this.assertAccess(job, input);
    let nextRun = this.deps.schedulePlanner.planResume({
      job,
      clock: this.clock(),
    });
    if (nextRun === undefined) {
      if (input.invalidSchedulePolicy === 'dead_letter') {
        const pauseReason = `Cannot resume with invalid schedule configuration (${job.schedule_type}:${job.schedule_value}).`;
        await this.deps.ops.updateJob(job.id, {
          status: 'dead_lettered',
          pause_reason: pauseReason,
          next_run: null,
        });
        this.deps.scheduler.requestSchedulerSync(job.id);
        throw new ApplicationError(
          'INVALID_SCHEDULE',
          'Cannot resume scheduler job due to invalid schedule.',
          {
            details: [
              pauseReason,
              'Job has been moved to dead_lettered state.',
            ],
          },
        );
      }
      nextRun = this.clock().now();
    }
    const updates: Partial<Job> = {
      status: 'active',
      pause_reason: null,
      next_run: nextRun,
    };
    await this.deps.ops.updateJob(job.id, updates);
    this.deps.scheduler.requestSchedulerSync(job.id);
    return { resumed: true, job: { ...job, ...updates } };
  }

  async triggerJob(input: {
    appId: string;
    jobId: string;
    consumeRateLimit?: (key: string, limit: number) => boolean;
    perAppLimit: number;
    perJobLimit: number;
  }): Promise<{ triggerId: string }> {
    const control = this.requireControl();
    const runtimeEvents = this.requireRuntimeEvents();
    const triggerQueue = this.requireTriggerQueue();
    const job = await this.requireJob(input.jobId);
    assertJobBelongsToApp(job, input.appId);
    const appSession = await this.resolveJobAppSession(job, input.appId);
    if (!appSession) {
      throw new ApplicationError(
        'FORBIDDEN',
        'API key cannot access this job session',
      );
    }
    if (!triggerQueue.isReady()) {
      throw new ApplicationError(
        'SCHEDULER_NOT_READY',
        'Scheduler is not ready to accept job triggers',
      );
    }
    if (
      input.consumeRateLimit &&
      (!input.consumeRateLimit(`app:${input.appId}`, input.perAppLimit) ||
        !input.consumeRateLimit(
          `app:${input.appId}:job:${job.id}`,
          input.perJobLimit,
        ))
    ) {
      throw new ApplicationError(
        'RATE_LIMITED',
        'Too many job trigger requests',
      );
    }

    const trigger = await control.createJobTrigger({
      jobId: job.id,
      requestedBy: encodeTriggerRequester({
        appId: input.appId,
        sessionId: appSession.sessionId,
      }),
    });
    if (job.status === 'paused' || job.status === 'dead_lettered') {
      try {
        await this.resumeJob({
          appId: input.appId,
          jobId: job.id,
          invalidSchedulePolicy: 'resume_now',
        });
      } catch (err) {
        await control.markTriggerCompleted(trigger.triggerId, 'failed');
        throw err;
      }
    }
    try {
      await triggerQueue.enqueue(job.id, trigger.triggerId);
    } catch (err) {
      await control.markTriggerCompleted(trigger.triggerId, 'failed');
      throw new ApplicationError(
        'SCHEDULER_NOT_READY',
        err instanceof Error
          ? err.message
          : 'Scheduler is not ready to accept job triggers',
      );
    }
    await runtimeEvents.publish({
      appId: appSession.appId as never,
      eventType: RUNTIME_EVENT_TYPES.JOB_TRIGGERED,
      payload: {
        triggerId: trigger.triggerId,
        jobId: job.id,
      },
      actor: 'sdk',
      sessionId: appSession.sessionId as never,
      jobId: job.id as never,
      triggerId: trigger.triggerId,
      responseMode: appSession.defaultResponseMode,
      webhookId: appSession.defaultWebhookId,
    });
    return { triggerId: trigger.triggerId };
  }

  async runJobNowFromMcp(input: SchedulerRunNowInput): Promise<{
    runId: string;
    queued: true;
    triggerId: string;
  }> {
    return runSchedulerJobNowFromMcp(this.deps, input);
  }

  async waitForTrigger(input: {
    appId: string;
    triggerId: string;
    timeoutMs: number;
  }): Promise<{
    triggerId: string;
    runId: string;
    status: string;
    resultSummary: string | null;
    errorSummary: string | null;
  }> {
    const control = this.requireControl();
    const initialTrigger = await control.getTriggerById(input.triggerId);
    if (!initialTrigger) {
      throw new ApplicationError('TRIGGER_NOT_FOUND', 'Trigger not found');
    }
    const job = await this.requireJob(initialTrigger.jobId);
    assertJobBelongsToApp(job, input.appId);
    const startedAt = Date.now();
    const subscription = this.deps.runtimeEvents?.subscribe?.({
      appId: input.appId as never,
      triggerId: input.triggerId,
    });
    try {
      while (Date.now() - startedAt < input.timeoutMs) {
        const completed = await this.getCompletedTriggerRun(input.triggerId);
        if (completed) return completed;
        const remaining = input.timeoutMs - (Date.now() - startedAt);
        if (remaining <= 0) break;
        if (subscription) {
          await subscription.next({
            timeoutMs: Math.min(remaining, TRIGGER_POLL_INTERVAL_MS),
          });
        } else {
          await new Promise((resolve) =>
            setTimeout(resolve, Math.min(remaining, TRIGGER_POLL_INTERVAL_MS)),
          );
        }
      }
    } finally {
      subscription?.close();
    }
    throw new ApplicationError(
      'WAIT_TIMEOUT',
      'Timed out waiting for trigger completion',
    );
  }

  private async getCompletedTriggerRun(triggerId: string): Promise<{
    triggerId: string;
    runId: string;
    status: string;
    resultSummary: string | null;
    errorSummary: string | null;
  } | null> {
    const control = this.requireControl();
    const trigger = await control.getTriggerById(triggerId);
    if (!trigger)
      throw new ApplicationError('TRIGGER_NOT_FOUND', 'Trigger not found');
    if (trigger.runId) {
      const run = await this.deps.ops.getJobRunById(trigger.runId);
      if (run && run.status !== 'running') {
        return {
          triggerId: trigger.triggerId,
          runId: run.run_id,
          status: run.status,
          resultSummary: run.result_summary,
          errorSummary: run.error_summary,
        };
      }
    }
    return null;
  }

  async listJobRuns(input: {
    appId?: string;
    access?: SchedulerJobAccess;
    jobId?: string;
    limit?: number;
  }): Promise<{ runs: JobRun[] }> {
    if (input.jobId) {
      const job = await this.getVisibleJobForScopedRead({
        jobId: input.jobId,
        appId: input.appId,
        access: input.access,
      });
      if (!job) return { runs: [] };
    }
    const runs = await this.deps.ops.listJobRuns(
      input.jobId,
      resolveLimit(input.limit, DEFAULT_RUN_LIMIT),
      input.jobId
        ? undefined
        : { jobIds: await this.visibleJobIdsArray(input) },
    );
    if (input.jobId) return { runs };
    return { runs };
  }

  async listJobEvents(input: {
    appId?: string;
    access?: SchedulerJobAccess;
    jobId?: string;
    runId?: string;
    eventType?: string;
    sinceId?: number;
    since?: string;
    limit?: number;
  }): Promise<{ events: JobEvent[] }> {
    if (input.jobId) {
      const job = await this.getVisibleJobForScopedRead({
        jobId: input.jobId,
        appId: input.appId,
        access: input.access,
      });
      if (!job) return { events: [] };
    }
    const visibleJobIds = input.jobId
      ? undefined
      : await this.visibleJobIdsArray(input);
    const events = await this.deps.ops.listRecentJobEvents(
      resolveLimit(input.limit, DEFAULT_EVENT_LIMIT),
      {
        app_id: input.jobId || visibleJobIds ? undefined : input.appId,
        job_id: input.jobId,
        job_ids: visibleJobIds,
        run_id: input.runId,
        event_type: input.eventType,
        since_id: input.sinceId,
        since: input.since,
      },
    );
    return { events };
  }

  async listDeadLetterRuns(input: {
    appId?: string;
    access?: SchedulerJobAccess;
    limit?: number;
  }): Promise<{ deadLetterRuns: JobRun[] }> {
    const runs = await this.deps.ops.listDeadLetterRuns(
      resolveLimit(input.limit, DEFAULT_DEAD_LETTER_LIMIT),
    );
    if (!input.appId && !input.access) return { deadLetterRuns: runs };
    const visible = await this.filterRunsByVisibleJobs(runs, input);
    return { deadLetterRuns: visible };
  }

  private async requireJob(jobId: string): Promise<Job> {
    const job = await this.deps.ops.getJobById(jobId);
    if (!job) throw new ApplicationError('NOT_FOUND', 'Job not found');
    return job;
  }

  private async getVisibleJobForScopedRead(input: {
    jobId: string;
    appId?: string;
    access?: SchedulerJobAccess;
  }): Promise<Job | null> {
    const job = await this.deps.ops.getJobById(input.jobId);
    if (!job) return null;
    this.assertAccess(job, input);
    return job;
  }

  private assertAccess(
    job: Job,
    input: { appId?: string; access?: SchedulerJobAccess },
  ): void {
    if (input.appId) assertJobBelongsToApp(job, input.appId);
    if (input.access) assertSchedulerJobAccess(job, input.access);
  }

  private clock(): Clock {
    return this.deps.clock ?? { now: () => new Date().toISOString() };
  }

  private requireControl(): JobControlPort {
    if (!this.deps.control) {
      throw new ApplicationError(
        'UNAVAILABLE',
        'Job control repository unavailable',
      );
    }
    return this.deps.control;
  }

  private requireRuntimeEvents(): RuntimeEventPublisherPort {
    if (!this.deps.runtimeEvents) {
      throw new ApplicationError(
        'UNAVAILABLE',
        'Runtime event publisher unavailable',
      );
    }
    return this.deps.runtimeEvents;
  }

  private requireTriggerQueue(): JobTriggerQueuePort {
    if (!this.deps.triggerQueue) {
      throw new ApplicationError(
        'UNAVAILABLE',
        'Scheduler trigger queue unavailable',
      );
    }
    return this.deps.triggerQueue;
  }

  private async resolveJobAppSession(
    job: Job,
    appId: string,
  ): Promise<AppSessionRecord | undefined> {
    const control = this.requireControl();
    const appChatJids = (
      Array.isArray(job.linked_sessions) ? job.linked_sessions : []
    ).filter((chatJid) => chatJid.startsWith(`app:${appId}:`));
    if (control.getAppSessionsByChatJids) {
      const sessions = await control.getAppSessionsByChatJids(appChatJids);
      return sessions.find((session) => session.appId === appId);
    }
    for (const chatJid of appChatJids) {
      if (!chatJid.startsWith(`app:${appId}:`)) continue;
      const session = await control.getAppSessionByChatJid(chatJid);
      if (session?.appId === appId) return session;
    }
    return undefined;
  }

  private async visibleJobIdsArray(input: {
    appId?: string;
    access?: SchedulerJobAccess;
  }): Promise<string[] | undefined> {
    if (!input.appId && !input.access) return undefined;
    const { jobs } = await this.listJobs(input);
    return jobs.map((job) => job.id);
  }

  private async filterRunsByVisibleJobs(
    runs: JobRun[],
    input: { appId?: string; access?: SchedulerJobAccess },
  ): Promise<JobRun[]> {
    const visibleJobs = new Set(await this.visibleJobIdsArray(input));
    return runs.filter((run) => visibleJobs.has(run.job_id));
  }
}
