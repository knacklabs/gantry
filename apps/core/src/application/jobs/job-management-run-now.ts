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
      recovery_intent: null,
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
