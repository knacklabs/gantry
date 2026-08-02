import type { Job } from '../domain/types.js';
import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import type { RuntimeEventPublishInput } from '../domain/events/events.js';
import type { SchedulerEventAppSession } from './app-session-resolution.js';

export async function publishSchedulerRunCompletion(input: {
  currentJob: Job;
  runId: string;
  runStatus: 'paused' | 'completed' | 'failed' | 'timeout' | 'dead_lettered';
  notified: boolean;
  startNotified: boolean;
  summary: string;
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
  let eventAppSession = input.eventAppSession;
  try {
    eventAppSession = eventAppSession ?? (await input.resolveEventAppSession());
    if (input.boundTriggerId) {
      await input.markTriggerCompleted(
        input.runStatus === 'completed' ? 'completed' : 'failed',
      );
    }
    const completionEventAppId = eventAppSession?.appId ?? input.runtimeAppId;
    if (!completionEventAppId) return eventAppSession;
    await input.publishRuntimeEvent({
      appId: completionEventAppId as never,
      eventType:
        input.runStatus === 'completed'
          ? RUNTIME_EVENT_TYPES.JOB_RUN_COMPLETED
          : RUNTIME_EVENT_TYPES.JOB_RUN_FAILED,
      payload: {
        jobId: input.currentJob.id,
        runId: input.runId,
        status: input.runStatus,
        deliveryState: input.notified ? 'sent' : 'not_sent',
        startNotificationState: input.startNotified ? 'sent' : 'not_sent',
        summary: input.summary,
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
