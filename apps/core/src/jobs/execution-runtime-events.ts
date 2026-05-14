import type { Job } from '../domain/types.js';
import type { RuntimeEventPublishInput } from '../domain/events/events.js';
import {
  RUNTIME_EVENT_TYPES,
  type RuntimeEventType,
} from '../domain/events/runtime-event-types.js';
import {
  resolveAppSessionForJob,
  resolveAppSessionForTrigger,
  type SchedulerEventAppSession,
} from './app-session-resolution.js';
import { publishSchedulerRunCompletion } from './execution-completion-events.js';
import type { SchedulerDispatchPayload } from './types.js';

interface RuntimeControlEventRepository {
  bindTriggerToRun(
    triggerId: string,
    runId: string,
  ): Promise<
    | {
        triggerId: string;
        requestedBy: string;
      }
    | null
    | undefined
  >;
  bindPendingTriggerToRun(
    jobId: string,
    runId: string,
  ): Promise<
    | {
        triggerId: string;
        requestedBy: string;
      }
    | null
    | undefined
  >;
  getAppSessionById(
    sessionId: string,
  ): Promise<SchedulerEventAppSession | null | undefined>;
  markTriggerCompleted(
    triggerId: string,
    status: 'completed' | 'failed',
  ): Promise<void>;
}

export interface SchedulerRunEventState {
  boundTriggerId?: string;
  eventAppSession?: SchedulerEventAppSession;
}

export async function bindSchedulerRunEventState(input: {
  currentJob: Job;
  dispatch?: SchedulerDispatchPayload;
  runId: string;
  runShortId: number | null;
  scheduledFor: string;
  runtimeAppId: string;
  control: RuntimeControlEventRepository;
  publishRuntimeEvent: (event: RuntimeEventPublishInput) => Promise<unknown>;
  logger: {
    warn(context: Record<string, unknown>, message: string): void;
  };
}): Promise<SchedulerRunEventState> {
  try {
    const boundTrigger = input.dispatch?.triggerId
      ? await input.control.bindTriggerToRun(
          input.dispatch.triggerId,
          input.runId,
        )
      : await input.control.bindPendingTriggerToRun(
          input.currentJob.id,
          input.runId,
        );
    const eventAppSession =
      (boundTrigger
        ? await resolveAppSessionForTrigger(
            boundTrigger.requestedBy,
            input.control,
          )
        : undefined) ??
      (await resolveAppSessionForJob(input.currentJob, input.control));
    const startEventAppId = eventAppSession?.appId ?? input.runtimeAppId;
    if (startEventAppId) {
      await input.publishRuntimeEvent({
        appId: startEventAppId as never,
        eventType: RUNTIME_EVENT_TYPES.JOB_RUN_STARTED,
        payload: {
          jobId: input.currentJob.id,
          runId: input.runId,
          short_id: input.runShortId,
          scheduledFor: input.scheduledFor,
        },
        actor: 'scheduler',
        sessionId: eventAppSession?.sessionId as never,
        jobId: input.currentJob.id as never,
        runId: input.runId as never,
        triggerId: boundTrigger?.triggerId,
        responseMode: eventAppSession?.defaultResponseMode,
        webhookId: eventAppSession?.defaultWebhookId,
      });
    }
    return {
      boundTriggerId: boundTrigger?.triggerId,
      eventAppSession,
    };
  } catch (err) {
    input.logger.warn(
      { err, jobId: input.currentJob.id, runId: input.runId },
      'Failed to bind scheduler run event state',
    );
    return {};
  }
}

export function createSchedulerJobEventEmitter(input: {
  currentJob: Job;
  runId: string;
  runtimeAppId: string;
  state: SchedulerRunEventState;
  resolveEventAppSession: () => Promise<SchedulerEventAppSession>;
  publishRuntimeEvent: (event: RuntimeEventPublishInput) => Promise<unknown>;
  deletionGuard: { isJobDeleted(force?: boolean): Promise<boolean> };
  logger: {
    warn(context: Record<string, unknown>, message: string): void;
  };
}): (
  eventType: RuntimeEventType,
  payload: Record<string, unknown> | null,
) => Promise<void> {
  return async (eventType, payload): Promise<void> => {
    if (await input.deletionGuard.isJobDeleted(true)) return;
    try {
      const appSession =
        input.state.eventAppSession ?? (await input.resolveEventAppSession());
      const eventAppId = appSession?.appId ?? input.runtimeAppId;
      if (!eventAppId) return;
      await input.publishRuntimeEvent({
        appId: eventAppId as never,
        eventType,
        payload,
        actor: 'scheduler',
        sessionId: appSession?.sessionId as never,
        jobId: input.currentJob.id as never,
        runId: input.runId as never,
        triggerId: input.state.boundTriggerId,
        responseMode: appSession?.defaultResponseMode,
        webhookId: appSession?.defaultWebhookId,
      });
    } catch (err) {
      input.logger.warn(
        { err, jobId: input.currentJob.id, runId: input.runId, eventType },
        'Failed to write scheduler lifecycle event',
      );
    }
  };
}

export async function publishSchedulerCompletionEvent(input: {
  currentJob: Job;
  runId: string;
  runStatus: 'completed' | 'failed' | 'timeout' | 'dead_lettered';
  notified: boolean;
  startNotified: boolean;
  summary: string;
  nextRun: string | null;
  state: SchedulerRunEventState;
  runtimeAppId: string;
  control: RuntimeControlEventRepository;
  publishRuntimeEvent: (event: RuntimeEventPublishInput) => Promise<unknown>;
  logger: {
    warn(context: Record<string, unknown>, message: string): void;
  };
}): Promise<void> {
  input.state.eventAppSession = await publishSchedulerRunCompletion({
    currentJob: input.currentJob,
    runId: input.runId,
    runStatus: input.runStatus,
    notified: input.notified,
    startNotified: input.startNotified,
    summary: input.summary,
    nextRun: input.nextRun,
    boundTriggerId: input.state.boundTriggerId,
    eventAppSession: input.state.eventAppSession,
    resolveEventAppSession: () =>
      resolveAppSessionForJob(input.currentJob, input.control),
    markTriggerCompleted: (status) =>
      input.control.markTriggerCompleted(input.state.boundTriggerId!, status),
    publishRuntimeEvent: async (event) => {
      await input.publishRuntimeEvent(event);
    },
    runtimeAppId: input.runtimeAppId,
    logger: input.logger,
  });
}
