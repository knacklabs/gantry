import type { Job } from '../domain/types.js';
import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import type { RuntimeEventPublishInput } from '../domain/events/events.js';
import type { SchedulerEventAppSession } from './app-session-resolution.js';
import type { AgentFailureMetadata } from '../domain/ports/async-tasks.js';

export async function publishSchedulerRunCompletion(input: {
  currentJob: Job;
  runId: string;
  runStatus: 'paused' | 'completed' | 'failed' | 'timeout' | 'dead_lettered';
  notified: boolean;
  startNotified: boolean;
  summary: string;
  pauseReason?: string | null;
  pauseCode?: string;
  result?: string | null;
  failure?: AgentFailureMetadata;
  completionGateAccepted?: boolean;
  structuredResultValidated?: boolean;
  nextRun: string | null;
  boundTriggerId?: string;
  eventAppSession?: SchedulerEventAppSession;
  resolveEventAppSession: () => Promise<SchedulerEventAppSession | undefined>;
  markTriggerCompleted: (
    status: 'completed' | 'failed',
  ) => Promise<void> | void;
  publishRuntimeEvent: (
    event: RuntimeEventPublishInput,
  ) => Promise<void> | void;
  runtimeAppId: string;
  logger: {
    warn(payload: Record<string, unknown>, message: string): void;
  };
}): Promise<SchedulerEventAppSession | undefined> {
  const completionEvidenceValid =
    (!input.currentJob.agent_task?.responseSchema ||
      (input.structuredResultValidated === true && Boolean(input.result))) &&
    (!input.currentJob.agent_task?.completionGate ||
      input.completionGateAccepted === true);
  const eventRunStatus =
    input.runStatus === 'completed' && !completionEvidenceValid
      ? 'failed'
      : input.runStatus;
  let eventAppSession = input.eventAppSession;
  try {
    eventAppSession = eventAppSession ?? (await input.resolveEventAppSession());
    if (input.boundTriggerId) {
      await input.markTriggerCompleted(
        eventRunStatus === 'completed' || eventRunStatus === 'paused'
          ? 'completed'
          : 'failed',
      );
    }
    // A paused run is an intermediate lifecycle state. In particular, an
    // external capability task deliberately suspends the run until its fenced
    // completion starts a continuation. `run.paused` is emitted by the
    // scheduler; publishing `job.run.failed` here would incorrectly make
    // downstream business projectors terminalize an otherwise resumable job.
    if (
      eventRunStatus === 'paused' &&
      input.pauseCode !== 'cumulative_runtime_exhausted'
    ) {
      return eventAppSession;
    }
    const completionEventAppId = eventAppSession?.appId ?? input.runtimeAppId;
    if (!completionEventAppId) return eventAppSession;
    await input.publishRuntimeEvent({
      appId: completionEventAppId as never,
      eventType:
        eventRunStatus === 'completed'
          ? RUNTIME_EVENT_TYPES.JOB_RUN_COMPLETED
          : RUNTIME_EVENT_TYPES.JOB_RUN_FAILED,
      payload: {
        jobId: input.currentJob.id,
        runId: input.runId,
        status: eventRunStatus,
        deliveryState: input.notified ? 'sent' : 'not_sent',
        startNotificationState: input.startNotified ? 'sent' : 'not_sent',
        summary: input.summary,
        ...(input.pauseReason ? { pauseReason: input.pauseReason } : {}),
        ...(input.pauseCode ? { pauseCode: input.pauseCode } : {}),
        ...(input.result ? { result: input.result } : {}),
        ...(input.failure ? { failure: input.failure } : {}),
        nextRun: input.nextRun,
      },
      actor: 'scheduler',
      sessionId: eventAppSession?.sessionId as never,
      jobId: input.currentJob.id as never,
      runId: input.runId as never,
      triggerId: input.boundTriggerId,
      responseMode: eventAppSession?.defaultResponseMode,
      webhookId: eventAppSession?.defaultWebhookId,
    });
  } catch (err) {
    input.logger.warn(
      { err, jobId: input.currentJob.id, runId: input.runId },
      'Failed to publish scheduler run completion event',
    );
  }
  return eventAppSession;
}
