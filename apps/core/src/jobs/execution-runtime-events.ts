import type { Job } from '../domain/types.js';
import type {
  RuntimeEvent,
  RuntimeEventFilter,
  RuntimeEventPublishInput,
} from '../domain/events/events.js';
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
import type { JobToolDenial } from '../domain/events/job-tool-denial.js';
import { redactProviderSessionHandlesInText } from '../shared/provider-session-redaction.js';
import {
  jobToolDenialIdempotencyKey,
  toolDenialEventPayload,
} from './execution-diagnostics.js';
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

const RECORDED_TOOL_ACTION_BATCH_SIZE = 500;

export async function listRecordedToolActions(input: {
  filter: RuntimeEventFilter;
  listRuntimeEvents(filter: RuntimeEventFilter): Promise<RuntimeEvent[]>;
}): Promise<RuntimeEvent[]> {
  const actions: RuntimeEvent[] = [];
  let afterEventId = input.filter.afterEventId;
  for (;;) {
    const batch = await input.listRuntimeEvents({
      ...input.filter,
      ...(afterEventId === undefined ? {} : { afterEventId }),
      limit: RECORDED_TOOL_ACTION_BATCH_SIZE,
    });
    actions.push(...batch);
    if (batch.length < RECORDED_TOOL_ACTION_BATCH_SIZE) return actions;
    const nextEventId = batch.at(-1)?.eventId;
    if (nextEventId === undefined || nextEventId === afterEventId) {
      return actions;
    }
    afterEventId = nextEventId;
  }
}

export async function listRecordedJobRunActions(input: {
  appId: string;
  jobId: string;
  runId: string;
  listRuntimeEvents(filter: RuntimeEventFilter): Promise<RuntimeEvent[]>;
}): Promise<RuntimeEvent[]> {
  try {
    return await listRecordedToolActions({
      filter: {
        appId: input.appId as never,
        jobId: input.jobId as never,
        runId: input.runId as never,
        eventTypes: [
          RUNTIME_EVENT_TYPES.TOOL_ACTIVITY,
          RUNTIME_EVENT_TYPES.JOB_TOOL_DENIED,
        ],
      },
      listRuntimeEvents: input.listRuntimeEvents,
    });
  } catch {
    return [];
  }
}

export interface SchedulerRunEventState {
  boundTriggerId?: string;
  eventAppSession?: SchedulerEventAppSession;
  // The bound trigger was a scheduler_retry_ask tap: this one run must ask
  // interactively regardless of the job's configured permission mode.
  interactiveAskOverride?: boolean;
}

function isRetryAskRequestedBy(requestedBy: string | undefined): boolean {
  if (!requestedBy) return false;
  try {
    const parsed = JSON.parse(requestedBy) as { kind?: unknown };
    return parsed.kind === 'scheduler_retry_ask';
  } catch {
    return false;
  }
}

export function createRuntimeEventPublisher(input: {
  publish(event: RuntimeEventPublishInput): Promise<unknown>;
}): (event: RuntimeEventPublishInput) => Promise<void> {
  return (event) => input.publish(event).then(() => undefined);
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
      interactiveAskOverride:
        isRetryAskRequestedBy(boundTrigger?.requestedBy) || undefined,
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
  correlationId?: string,
) => Promise<void> {
  return async (eventType, payload, correlationId): Promise<void> => {
    if (await input.deletionGuard.isJobDeleted(true)) return;
    try {
      const appSession =
        input.state.eventAppSession ?? (await input.resolveEventAppSession());
      const eventAppId = appSession?.appId ?? input.runtimeAppId;
      if (!eventAppId) return;
      await input.publishRuntimeEvent({
        appId: eventAppId as never,
        eventType,
        ...(correlationId ? { correlationId } : {}),
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
  runStatus: 'paused' | 'completed' | 'failed' | 'timeout' | 'dead_lettered';
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

// S2a (decision 0126): the required terminal-denial append, extracted from the
// run epilogue. Returns the run-error string on append failure so the caller
// routes it into finalization's retry branch (never past it into the failsafe).
export async function publishTerminalToolDenials(input: {
  denials: JobToolDenial[];
  error: string | null;
  currentJob: Job;
  runId: string;
  runtimeAppId: string;
  eventState: SchedulerRunEventState;
  eventControl: Parameters<typeof resolveAppSessionForJob>[1];
  publishRuntimeEvent: (event: RuntimeEventPublishInput) => Promise<void>;
}): Promise<string | null> {
  let failure: string | null = null;
  const safeError =
    input.error === null
      ? null
      : redactProviderSessionHandlesInText(input.error);
  for (const denial of input.denials) {
    try {
      const appSession =
        input.eventState.eventAppSession ??
        (await resolveAppSessionForJob(input.currentJob, input.eventControl));
      await input.publishRuntimeEvent({
        appId: (appSession?.appId ?? input.runtimeAppId) as never,
        eventType: RUNTIME_EVENT_TYPES.JOB_TOOL_DENIED,
        payload: toolDenialEventPayload(denial, safeError),
        actor: 'scheduler',
        correlationId: denial.invocationId,
        sessionId: appSession?.sessionId as never,
        jobId: input.currentJob.id as never,
        runId: input.runId as never,
        triggerId: input.eventState.boundTriggerId,
        responseMode: appSession?.defaultResponseMode,
        webhookId: appSession?.defaultWebhookId,
        idempotencyKey: jobToolDenialIdempotencyKey(input.runId, denial),
      });
    } catch (appendError) {
      failure = `Failed to record terminal tool denial: ${appendError instanceof Error ? appendError.message : String(appendError)}`;
    }
  }
  return failure;
}
