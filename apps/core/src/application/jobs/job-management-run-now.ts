import { sha256Hex } from '../../shared/stable-hash.js';
import { RUNTIME_EVENT_TYPES } from '../../domain/events/runtime-event-types.js';
import { ApplicationError } from '../common/application-error.js';
import { assertSchedulerJobAccess } from './job-management-access.js';
import { assertPublicJobNamespace } from './job-management-helpers.js';
import type {
  JobControlPort,
  JobManagementServiceDeps,
  JobTriggerQueuePort,
  RuntimeEventPublisherPort,
  SchedulerRunNowInput,
} from './job-management-types.js';
import {
  evaluateManagedJobReadiness,
  pauseJobForSetup,
  setupBlockerDetails,
} from './job-management-readiness.js';
import { SETUP_REQUIRED_PAUSE_REASON } from './job-readiness-service.js';
import { agentIdForJobWorkspaceKey } from './job-tool-policy.js';

function requireControl(deps: JobManagementServiceDeps): JobControlPort {
  if (!deps.control) {
    throw new ApplicationError(
      'UNAVAILABLE',
      'Job control repository unavailable',
    );
  }
  return deps.control;
}

function requireRuntimeEvents(
  deps: JobManagementServiceDeps,
): RuntimeEventPublisherPort {
  if (!deps.runtimeEvents) {
    throw new ApplicationError(
      'UNAVAILABLE',
      'Runtime event publisher unavailable',
    );
  }
  return deps.runtimeEvents;
}

function requireTriggerQueue(
  deps: JobManagementServiceDeps,
): JobTriggerQueuePort {
  if (!deps.triggerQueue) {
    throw new ApplicationError(
      'UNAVAILABLE',
      'Scheduler trigger queue unavailable',
    );
  }
  return deps.triggerQueue;
}

/**
 * CARDFIX-1: "Allow once for this run" on a pause card. A job paused for setup
 * whose remaining blockers are all runtime-askable tools is resumed for exactly
 * one fresh run; that run asks via the standard ask-and-wait card and the
 * approval applies as the existing once-grant. Nothing durable is granted
 * (0134) and clearing the pause is the consumed one-shot: a second tap finds
 * the job no longer setup-paused and refuses instead of stacking runs.
 */
function stableRetryAskUuid(value: string): string {
  const hex = sha256Hex(value);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export async function retrySchedulerJobWithAskFromMcp(
  deps: JobManagementServiceDeps,
  input: SchedulerRunNowInput,
): Promise<{
  runId: string;
  queued: boolean;
  triggerId: string;
}> {
  const control = requireControl(deps);
  const runtimeEvents = requireRuntimeEvents(deps);
  const triggerQueue = requireTriggerQueue(deps);
  const job = await deps.ops.getJobById(input.jobId);
  if (!job) throw new ApplicationError('NOT_FOUND', 'Job not found');
  assertPublicJobNamespace({ jobId: job.id, prompt: job.prompt });
  assertSchedulerJobAccess(job, input.access);
  const fingerprint = job.setup_state?.fingerprint?.trim();
  if (!fingerprint) {
    throw new ApplicationError(
      'CONFLICT',
      'scheduler_retry_ask requires a recorded setup fingerprint.',
    );
  }
  const triggerId = stableRetryAskUuid(
    `scheduler-retry-ask:${job.id}:${fingerprint}:trigger`,
  );
  const runId = stableRetryAskUuid(
    `scheduler-retry-ask:${job.id}:${fingerprint}:run`,
  );
  const setupPaused =
    job.status === 'paused' && job.pause_reason === SETUP_REQUIRED_PAUSE_REASON;
  if (!setupPaused) {
    // Crash-replay: a tap that resumed the job but died before enqueueing left
    // the deterministic trigger pending — finish its dispatch instead of
    // refusing, so the promised run is never lost.
    const existing = await control.getTriggerById(triggerId);
    if (existing?.status === 'pending' && job.status === 'active') {
      // Duplicate/concurrent replays are safe: the delivery id derives from the
      // trigger id (pgBossSendId), so pg-boss ON CONFLICT DO NOTHING collapses
      // repeats, and claimDueRunStart fences the deterministic run id.
      await triggerQueue.enqueue(job.id, triggerId, { runId });
      return { runId, queued: true, triggerId };
    }
    throw new ApplicationError(
      'CONFLICT',
      'scheduler_retry_ask was already used or the job is no longer paused for setup.',
    );
  }
  const blockers = job.setup_state?.blockers ?? [];
  if (
    blockers.length === 0 ||
    blockers.some((blocker) => blocker.type !== 'tool')
  ) {
    throw new ApplicationError(
      'CONFLICT',
      'scheduler_retry_ask only covers tool permissions the run can ask for; complete the remaining setup first.',
      job.setup_state
        ? { details: setupBlockerDetails(job.setup_state) }
        : undefined,
    );
  }
  if (!triggerQueue.isReady()) {
    throw new ApplicationError(
      'SCHEDULER_NOT_READY',
      triggerQueue.notReadyReason?.() ??
        'Scheduler is not ready to accept job triggers',
    );
  }
  // One-shot per pause story: the trigger id derives from the setup
  // fingerprint, so concurrent taps converge on ONE durable trigger and a
  // crash before enqueue is replayable (the trigger stays pending). A trigger
  // already consumed (bound/completed) refuses instead of stacking runs —
  // mirrors the enqueueRunAgain contract.
  const trigger = await control.createJobTrigger({
    jobId: job.id,
    triggerId,
    requestedBy: JSON.stringify({
      kind: 'scheduler_retry_ask',
      setupFingerprint: fingerprint,
      sourceAgentFolder: input.access.sourceAgentFolder,
      conversationJid: input.access.originConversationJid,
    }),
  });
  if (trigger.status !== 'pending') {
    throw new ApplicationError(
      'CONFLICT',
      'scheduler_retry_ask was already used for this pause.',
    );
  }
  // Resume AFTER the durable trigger exists: the pause transition plus the
  // consumed trigger together are the one-shot marker.
  await deps.ops.updateJob(job.id, {
    status: 'active',
    pause_reason: null,
    next_run: null,
    lease_run_id: null,
    lease_expires_at: null,
  });
  deps.scheduler.requestSchedulerSync(job.id);
  try {
    await triggerQueue.enqueue(job.id, trigger.triggerId, { runId });
  } catch (err) {
    // Restore the replayable paused state and keep the trigger pending so a
    // later tap replays the dispatch instead of losing the promised run.
    await deps.ops.updateJob(job.id, {
      status: 'paused',
      pause_reason: SETUP_REQUIRED_PAUSE_REASON,
      next_run: null,
    });
    throw new ApplicationError(
      'ENQUEUE_FAILED',
      err instanceof Error ? err.message : 'Failed to enqueue scheduler run',
    );
  }
  const appSession = job.session_id
    ? await control.getAppSessionById(job.session_id)
    : undefined;
  const appId = appSession?.appId;
  if (appId) {
    await runtimeEvents.publish({
      appId: appId as never,
      eventType: RUNTIME_EVENT_TYPES.JOB_TRIGGERED,
      payload: {
        triggerId: trigger.triggerId,
        jobId: job.id,
        runId,
        triggeredBy: 'scheduler_retry_ask',
      },
      actor: 'user',
      sessionId: appSession?.sessionId as never,
      jobId: job.id as never,
      runId: runId as never,
      triggerId: trigger.triggerId,
      responseMode: appSession?.defaultResponseMode,
      webhookId: appSession?.defaultWebhookId,
    });
  }
  return { runId, queued: true, triggerId: trigger.triggerId };
}

export async function runSchedulerJobNowFromMcp(
  deps: JobManagementServiceDeps,
  input: SchedulerRunNowInput,
): Promise<{
  runId: string;
  queued: true;
  triggerId: string;
}> {
  const control = requireControl(deps);
  const runtimeEvents = requireRuntimeEvents(deps);
  const triggerQueue = requireTriggerQueue(deps);
  const job = await deps.ops.getJobById(input.jobId);
  if (!job) throw new ApplicationError('NOT_FOUND', 'Job not found');
  assertPublicJobNamespace({ jobId: job.id, prompt: job.prompt });
  assertSchedulerJobAccess(job, input.access);
  const canRecheckSetupPausedJob =
    job.status === 'paused' && job.pause_reason === SETUP_REQUIRED_PAUSE_REASON;
  if (job.status !== 'active' && !canRecheckSetupPausedJob) {
    throw new ApplicationError(
      'CONFLICT',
      `scheduler_run_now requires an active job; current status is ${job.status}.`,
    );
  }
  const appSession = job.session_id
    ? await control.getAppSessionById(job.session_id)
    : undefined;
  const readinessAppId =
    appSession?.appId ??
    (job.session_id ? `unresolved:${job.session_id}` : undefined);
  const readiness = await evaluateManagedJobReadiness({
    deps,
    job,
    appId: readinessAppId,
    agentId: agentIdForJobWorkspaceKey(input.access.sourceAgentFolder),
  });
  if (!readiness.ready) {
    await pauseJobForSetup({ deps, job, readiness });
    throw new ApplicationError(
      'CONFLICT',
      'scheduler_run_now requires setup before the job can be queued.',
      { details: setupBlockerDetails(readiness.setupState) },
    );
  }
  if (canRecheckSetupPausedJob) {
    await deps.ops.updateJob(job.id, {
      status: 'active',
      pause_reason: null,
      next_run: null,
      setup_state: readiness.setupState,
      lease_run_id: null,
      lease_expires_at: null,
    });
    deps.scheduler.requestSchedulerSync(job.id);
  }
  if (!triggerQueue.isReady()) {
    throw new ApplicationError(
      'SCHEDULER_NOT_READY',
      triggerQueue.notReadyReason?.() ??
        'Scheduler is not ready to accept job triggers',
    );
  }
  const trigger = await control.createJobTrigger({
    jobId: job.id,
    requestedBy: JSON.stringify({
      kind: 'mcp',
      sourceAgentFolder: input.access.sourceAgentFolder,
      conversationJid: input.access.originConversationJid,
    }),
  });
  try {
    await triggerQueue.enqueue(job.id, trigger.triggerId, {
      runId: input.runId,
    });
  } catch (err) {
    await control.markTriggerCompleted(trigger.triggerId, 'failed');
    throw new ApplicationError(
      'ENQUEUE_FAILED',
      err instanceof Error ? err.message : 'Failed to enqueue scheduler run',
    );
  }
  const appId = appSession?.appId;
  if (appId) {
    await runtimeEvents.publish({
      appId: appId as never,
      eventType: RUNTIME_EVENT_TYPES.JOB_TRIGGERED,
      payload: {
        triggerId: trigger.triggerId,
        jobId: job.id,
        runId: input.runId,
        triggeredBy: 'mcp',
      },
      actor: 'agent',
      sessionId: appSession?.sessionId as never,
      jobId: job.id as never,
      runId: input.runId as never,
      triggerId: trigger.triggerId,
      responseMode: appSession?.defaultResponseMode,
      webhookId: appSession?.defaultWebhookId,
    });
  }
  return {
    runId: input.runId,
    queued: true,
    triggerId: trigger.triggerId,
  };
}
