import { RUNTIME_EVENT_TYPES } from '../../domain/events/runtime-event-types.js';
import { ApplicationError } from '../common/application-error.js';
import type { Clock } from '../common/clock.js';
// prettier-ignore
import { DEFAULT_JOB_RUNTIME_APP_ID, filterJobsByCanonicalAppSession, resolveJobAppSession } from './job-access.js';
import { isVisibleJob } from './job-list-filters.js';
import {
  assertSchedulerJobAccess,
  normalizeOptional,
} from './job-management-access.js';
import { createManagedJob } from './job-management-create.js';
import {
  assertExecutionContextMatchesAuthenticatedContext,
  assertPublicJobNamespace,
  authenticatedContextFromAccess,
  encodeTriggerRequester,
  normalizeNotificationRoutes,
  normalizeStoredNotificationRoutes,
  normalizeScheduleType,
  requireJobNotificationRouteApproval,
  resolveCanonicalAppSessionForOrigin,
  resolveLimit,
  routesBeyondAuthenticatedContext,
} from './job-management-helpers.js';
import type {
  Job,
  JobManagementServiceDeps,
  JobUpsertInput,
  SchedulerJobAccess,
  SchedulerRunNowInput,
  CreateManagedJobInput,
  UpsertJobFromIpcInput,
  ManagedJobListInput,
  ManagedJobLookupInput,
  ManagedJobUpdateInput,
  ManagedJobDeleteInput,
  ManagedJobPauseInput,
  ManagedJobResumeInput,
  ManagedJobTriggerInput,
  ManagedJobTriggerWaitInput,
} from './job-management-types.js';
import { resolveRequestedJobModel } from './job-model-selection.js';
// prettier-ignore
import { requireJobControl, requireRuntimeEvents, requireTriggerQueue } from './job-management-require.js';
import { runSchedulerJobNowFromMcp } from './job-management-run-now.js';
// prettier-ignore
import { listManagedDeadLetterRuns, listManagedJobEvents, listManagedJobRuns } from './job-management-read-queries.js';
import { normalizeAccessRequirements } from './job-access-requirements.js';
import {
  applyJobReadinessToUpdates,
  evaluateManagedJobReadiness,
  pauseJobForSetup,
  recordJobSetupRequired,
  setupBlockerDetails,
} from './job-management-readiness.js';
import { waitForTriggerCompletion } from './job-management-trigger-wait.js';
import { assertJobAppAccess } from './job-management-context-access.js';
import { createJobVisibilityReaders } from './job-management-visibility-readers.js';
import { nowIso } from '../../shared/time/datetime.js';
import { updateManagedJob } from './job-management-update.js';
import { isTrustedSystemJob } from '../../shared/system-job-identity.js';

const DEFAULT_JOB_LIST_LIMIT = 100;
const MAX_JOB_LIST_LIMIT = 500;
export class JobManagementService {
  constructor(private readonly deps: JobManagementServiceDeps) {}

  async createJob(input: CreateManagedJobInput) {
    return createManagedJob(this.deps, input);
  }

  async upsertJobFromIpc(input: UpsertJobFromIpcInput) {
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
    assertPublicJobNamespace({ jobId: input.jobId, prompt });
    const schedule = this.deps.schedulePlanner.planInitial({
      scheduleType,
      scheduleValue: input.scheduleValue,
    });
    const modelAlias = resolveRequestedJobModel(
      input.modelAlias,
      scheduleType === 'cron' || scheduleType === 'interval'
        ? 'recurring_job'
        : 'one_time_job',
    );
    const workspaceKey = (
      input.workspaceKey || access.sourceAgentFolder
    ).trim();
    if (workspaceKey !== access.sourceAgentFolder) {
      throw new ApplicationError(
        'FORBIDDEN',
        'Scheduler jobs cannot be created outside the source group.',
      );
    }
    const authThreadId = normalizeOptional(input.access.authThreadId);
    const payloadThreadId = normalizeOptional(input.threadId);
    if (payloadThreadId && payloadThreadId !== authThreadId) {
      throw new ApplicationError(
        'FORBIDDEN',
        'threadId payload does not match authenticated thread binding.',
      );
    }
    const authenticatedContext = authenticatedContextFromAccess(
      access,
      workspaceKey,
    );
    const requestedJobId = normalizeOptional(input.jobId);
    let id = this.deps.schedulePlanner.createJobId({
      name,
      prompt,
      scheduleType,
      scheduleValue: input.scheduleValue,
      workspaceKey,
    });
    let existingJob: Job | undefined;
    if (requestedJobId) {
      existingJob = await this.deps.ops.getJobById(requestedJobId);
      if (existingJob) assertSchedulerJobAccess(existingJob, access);
      id = requestedJobId;
    }
    existingJob ??= await this.deps.ops.getJobById(id);
    if (existingJob) assertSchedulerJobAccess(existingJob, access);
    const executionContext = assertExecutionContextMatchesAuthenticatedContext({
      executionContext:
        input.executionContext === undefined
          ? (existingJob?.execution_context ?? {
              conversationJid: authenticatedContext.conversationJid,
              workspaceKey: authenticatedContext.workspaceKey,
              threadId: authThreadId ?? null,
            })
          : input.executionContext,
      authenticatedContext,
      enforceThread: input.executionContext !== undefined,
    });
    const existingNotificationRoutes = normalizeStoredNotificationRoutes(
      existingJob?.notification_routes,
    );
    const requestedNotificationRoutes = normalizeNotificationRoutes(
      input.notificationRoutes ??
        (existingNotificationRoutes.length > 0
          ? existingNotificationRoutes
          : [
              {
                conversationJid: authenticatedContext.conversationJid,
                threadId: authenticatedContext.threadId,
                label: 'primary',
              },
            ]),
    );
    const accessRequirements = normalizeAccessRequirements(
      input.accessRequirements ?? [],
    );

    const { canonicalSession } = await resolveCanonicalAppSessionForOrigin({
      access,
      control: this.deps.control,
    });
    const storedExecutionContext =
      canonicalSession?.sessionId && executionContext.sessionId == null
        ? { ...executionContext, sessionId: canonicalSession.sessionId }
        : executionContext;
    if (input.notificationRoutes !== undefined || !existingJob) {
      await requireJobNotificationRouteApproval({
        deps: this.deps as never,
        request: {
          operation: existingJob ? 'update' : 'create',
          jobId: id,
          jobName: name,
          authenticatedContext,
          requestedRoutes: requestedNotificationRoutes,
          existingRoutes: existingNotificationRoutes,
          routesBeyondContext: routesBeyondAuthenticatedContext({
            routes: requestedNotificationRoutes,
            authenticatedContext,
          }),
        },
      });
    }
    const job: JobUpsertInput = {
      id,
      name,
      prompt,
      model: modelAlias ?? null,
      schedule_type: scheduleType,
      schedule_value: input.scheduleValue.trim(),
      session_id: canonicalSession?.sessionId ?? null,
      thread_id: executionContext.threadId ?? null,
      workspace_key: workspaceKey,
      created_by: input.createdBy === 'human' ? 'human' : 'agent',
      status: 'active',
      next_run: schedule.nextRun,
      silent: input.silent === true,
      cleanup_after_ms: input.cleanupAfterMs,
      timeout_ms: input.timeoutMs,
      max_retries: input.maxRetries,
      retry_backoff_ms: input.retryBackoffMs,
      max_consecutive_failures: input.maxConsecutiveFailures,
      execution_context: storedExecutionContext,
      notification_routes: requestedNotificationRoutes,
      access_requirements: accessRequirements,
    };
    const readiness = await evaluateManagedJobReadiness({
      deps: this.deps,
      job,
      appId: canonicalSession?.appId,
    });
    if (!readiness.ready) {
      job.status = 'paused';
      job.pause_reason = readiness.pauseReason;
      job.next_run = null;
    }
    job.setup_state = readiness.setupState;
    const result = await this.deps.ops.upsertJob(job);
    if (!readiness.ready) {
      await recordJobSetupRequired({
        deps: this.deps,
        job,
        readiness,
        appId: canonicalSession?.appId,
      });
    }
    this.deps.scheduler.requestSchedulerSync(id);
    return {
      jobId: id,
      created: result.created,
      modelAlias,
      status: job.status ?? 'active',
      setupState: job.setup_state,
      pauseReason: job.pause_reason,
    };
  }

  async listJobs(input: ManagedJobListInput): Promise<{ jobs: Job[] }> {
    const queryWorkspaceKey = input.access
      ? input.access.sourceAgentFolder
      : input.workspaceKey;
    const repositoryAppId =
      input.appId === DEFAULT_JOB_RUNTIME_APP_ID ? undefined : input.appId;
    const jobs = await this.deps.ops.listJobs({
      appId: repositoryAppId,
      statuses: input.statuses,
      workspaceKey: queryWorkspaceKey,
      agentId: input.agentId,
      kind: input.kind,
      conversationJid: input.conversationJid,
      limit: Math.min(
        resolveLimit(input.limit, DEFAULT_JOB_LIST_LIMIT),
        MAX_JOB_LIST_LIMIT,
      ),
    });
    const appScopedJobs =
      input.appId && this.deps.control
        ? await filterJobsByCanonicalAppSession({
            control: this.deps.control,
            jobs,
            appId: input.appId,
          })
        : jobs;
    const visibleJobs = appScopedJobs.filter((job) =>
      isVisibleJob(job, {
        ...input,
        appId: this.deps.control ? undefined : input.appId,
      }),
    );
    return { jobs: visibleJobs };
  }

  async getJob(input: ManagedJobLookupInput): Promise<{ job: Job | null }> {
    const job = await this.deps.ops.getJobById(input.jobId);
    if (!job) return { job: null };
    if (input.appId) {
      await assertJobAppAccess({ deps: this.deps, job, appId: input.appId });
    }
    if (input.access) assertSchedulerJobAccess(job, input.access);
    return { job };
  }

  async updateJob(input: ManagedJobUpdateInput): Promise<{ job: Job }> {
    return updateManagedJob(this.deps, input, this.clock());
  }

  async deleteJob(input: ManagedJobDeleteInput): Promise<{ deleted: true }> {
    const job = await this.requireJob(input.jobId);
    assertPublicJobNamespace({ jobId: job.id });
    await this.assertAccess(job, input);
    await this.deps.ops.deleteJob(job.id);
    this.deps.scheduler.requestSchedulerSync(job.id);
    return { deleted: true };
  }

  async pauseJob(input: ManagedJobPauseInput): Promise<{ paused: true }> {
    const job = await this.requireJob(input.jobId);
    assertPublicJobNamespace({ jobId: job.id });
    await this.assertAccess(job, input);
    await this.deps.ops.updateJob(job.id, {
      status: 'paused',
      pause_reason: input.reason?.trim() || 'Paused by SDK',
      next_run: null,
    });
    this.deps.scheduler.requestSchedulerSync(job.id);
    return { paused: true };
  }

  async resumeJob(
    input: ManagedJobResumeInput,
  ): Promise<{ resumed: boolean; job: Job }> {
    const job = await this.requireJob(input.jobId);
    if (!isTrustedSystemJob(job)) assertPublicJobNamespace({ jobId: job.id });
    await this.assertAccess(job, input);
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
    const readiness = await evaluateManagedJobReadiness({
      deps: this.deps,
      job: { ...job, ...updates },
      appId: input.appId,
    });
    applyJobReadinessToUpdates(updates, readiness);
    await this.deps.ops.updateJob(job.id, updates);
    if (!readiness.ready) {
      await recordJobSetupRequired({
        deps: this.deps,
        job: { ...job, ...updates },
        readiness,
        appId: input.appId,
      });
    }
    this.deps.scheduler.requestSchedulerSync(job.id);
    return { resumed: readiness.ready, job: { ...job, ...updates } };
  }

  async triggerJob(
    input: ManagedJobTriggerInput,
  ): Promise<{ triggerId: string }> {
    const control = requireJobControl(this.deps);
    const runtimeEvents = requireRuntimeEvents(this.deps);
    const triggerQueue = requireTriggerQueue(this.deps);
    const job = await this.requireJob(input.jobId);
    assertPublicJobNamespace({ jobId: job.id });
    const appSession = await resolveJobAppSession({
      control,
      job,
      appId: input.appId,
    });
    if (!appSession) {
      throw new ApplicationError(
        'FORBIDDEN',
        'API key cannot access this job session',
      );
    }
    if (!triggerQueue.isReady()) {
      throw new ApplicationError(
        'SCHEDULER_NOT_READY',
        triggerQueue.notReadyReason?.() ??
          'Scheduler is not ready to accept job triggers',
      );
    }
    if (job.status === 'paused' || job.status === 'dead_lettered') {
      throw new ApplicationError(
        'CONFLICT',
        `Cannot trigger job while status is ${job.status}; resume the job explicitly first.`,
      );
    }
    const readiness = await evaluateManagedJobReadiness({
      deps: this.deps,
      job,
      appId: appSession.appId,
    });
    if (!readiness.ready) {
      await pauseJobForSetup({
        deps: this.deps,
        job,
        readiness,
        appId: appSession.appId,
      });
      throw new ApplicationError(
        'CONFLICT',
        'Job requires setup before it can be triggered.',
        { details: setupBlockerDetails(readiness.setupState) },
      );
    }
    if (
      input.consumeRateLimit &&
      (!input.consumeRateLimit(
        `app:${input.appId}:job:${job.id}`,
        input.perJobLimit,
      ) ||
        !input.consumeRateLimit(`app:${input.appId}`, input.perAppLimit))
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

  async waitForTrigger(input: ManagedJobTriggerWaitInput): Promise<{
    triggerId: string;
    runId: string;
    status: string;
    resultSummary: string | null;
    errorSummary: string | null;
  }> {
    return waitForTriggerCompletion({
      deps: this.deps,
      appId: input.appId,
      triggerId: input.triggerId,
      timeoutMs: input.timeoutMs,
      requireJob: (jobId) => this.requireJob(jobId),
      assertJobAppAccess: (job, appId) =>
        assertJobAppAccess({ deps: this.deps, job, appId }),
    });
  }

  async listJobRuns(input: {
    appId?: string;
    access?: SchedulerJobAccess;
    jobId?: string;
    limit?: number;
  }) {
    return listManagedJobRuns({
      deps: this.deps,
      visibility: this.visibilityReaders(),
      ...input,
    });
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
  }) {
    return listManagedJobEvents({
      deps: this.deps,
      visibility: this.visibilityReaders(),
      ...input,
    });
  }

  async listDeadLetterRuns(input: {
    appId?: string;
    access?: SchedulerJobAccess;
    limit?: number;
  }) {
    return listManagedDeadLetterRuns({
      deps: this.deps,
      visibility: this.visibilityReaders(),
      ...input,
    });
  }

  private async requireJob(jobId: string): Promise<Job> {
    const job = await this.deps.ops.getJobById(jobId);
    if (!job) throw new ApplicationError('NOT_FOUND', 'Job not found');
    return job;
  }

  private async assertAccess(
    job: Job,
    input: { appId?: string; access?: SchedulerJobAccess },
  ): Promise<void> {
    if (input.appId) {
      await assertJobAppAccess({ deps: this.deps, job, appId: input.appId });
    }
    if (input.access) assertSchedulerJobAccess(job, input.access);
  }

  private clock(): Clock {
    return this.deps.clock ?? { now: () => nowIso() };
  }

  private visibilityReaders() {
    return createJobVisibilityReaders({
      deps: this.deps,
      listJobs: (scope) => this.listJobs(scope),
    });
  }
}
