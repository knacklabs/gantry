import { RUNTIME_EVENT_TYPES } from '../../domain/events/runtime-event-types.js';
import { ApplicationError } from '../common/application-error.js';
import { resolveJobRuntimeAppId } from './job-access.js';
import { assertSchedulerJobAccess } from './job-management-access.js';
import type {
  JobControlPort,
  JobManagementServiceDeps,
  JobTriggerQueuePort,
  RuntimeEventPublisherPort,
  SchedulerRunNowInput,
} from './job-management-types.js';

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
  assertSchedulerJobAccess(job, input.access);
  if (job.status !== 'active') {
    throw new ApplicationError(
      'CONFLICT',
      `scheduler_run_now requires an active job; current status is ${job.status}.`,
    );
  }
  if (!triggerQueue.isReady()) {
    throw new ApplicationError(
      'SCHEDULER_NOT_READY',
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
  await runtimeEvents.publish({
    appId: resolveJobRuntimeAppId(job) as never,
    eventType: RUNTIME_EVENT_TYPES.JOB_TRIGGERED,
    payload: {
      triggerId: trigger.triggerId,
      jobId: job.id,
      runId: input.runId,
      triggeredBy: 'mcp',
    },
    actor: 'agent',
    jobId: job.id as never,
    runId: input.runId as never,
    triggerId: trigger.triggerId,
  });
  return {
    runId: input.runId,
    queued: true,
    triggerId: trigger.triggerId,
  };
}
