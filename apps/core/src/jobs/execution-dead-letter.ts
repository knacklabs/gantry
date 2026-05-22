import type { Job } from '../domain/types.js';
import {
  RUNTIME_EVENT_TYPES,
  type RuntimeEventType,
} from '../domain/events/runtime-event-types.js';
import type { RuntimeEventPublishInput } from '../domain/events/events.js';
import { nowMs } from '../shared/time/datetime.js';
import {
  resolveAppSessionForJob,
  resolveAppSessionForTrigger,
  type SchedulerEventAppSession,
} from './app-session-resolution.js';
import { publishSchedulerRunCompletion } from './execution-completion-events.js';
import { notifySchedulerTerminalRunState } from './execution-notifications.js';
import { runtimeEventTypeForRunStatus } from './run-status-event.js';
import type {
  SchedulerDependencies,
  SchedulerDispatchPayload,
} from './types.js';
import {
  DEFAULT_RUNTIME_EXECUTION_PROVIDER_ID,
  resolveRuntimeExecutionProviderId,
} from '../runtime/execution-provider-id.js';

interface SchedulerDeadLetterControl {
  bindTriggerToRun(
    triggerId: string,
    runId: string,
  ): Promise<{ triggerId: string; requestedBy: string } | undefined>;
  bindPendingTriggerToRun(
    jobId: string,
    runId: string,
  ): Promise<{ triggerId: string; requestedBy: string } | undefined>;
  getAppSessionById(
    sessionId: string,
  ): Promise<SchedulerEventAppSession | null | undefined>;
  markTriggerCompleted(
    triggerId: string,
    status: 'completed' | 'failed',
  ): Promise<void> | void;
}

interface SchedulerDeadLetterLogger {
  warn(payload: Record<string, unknown>, message: string): void;
}

export async function deadLetterUnresolvedExecutionContext(input: {
  currentJob: Job;
  deps: SchedulerDependencies;
  runId: string;
  scheduledFor: string;
  startedAt: string;
  startedAtMs: number;
  dispatch?: SchedulerDispatchPayload;
  runtimeAppId: string;
  control: SchedulerDeadLetterControl;
  publishRuntimeEvent: (
    event: RuntimeEventPublishInput,
  ) => Promise<void> | void;
  logger: SchedulerDeadLetterLogger;
}): Promise<void> {
  const unresolvedConversation =
    input.currentJob.execution_context?.conversationJid || 'unknown';
  const errorSummary = `Execution context route not found: ${unresolvedConversation}`;
  const retryCount = input.currentJob.consecutive_failures + 1;
  await input.deps.opsRepository.createJobRun({
    run_id: input.runId,
    job_id: input.currentJob.id,
    execution_provider_id:
      input.deps.executionAdapter || !input.deps.runAgent
        ? resolveRuntimeExecutionProviderId(input.deps.executionAdapter)
        : DEFAULT_RUNTIME_EXECUTION_PROVIDER_ID,
    provider_run_id: null,
    provider_session_id: null,
    worker_id: input.currentJob.execution_context?.groupScope ?? null,
    lease_owner: input.currentJob.execution_context?.conversationJid ?? null,
    lease_expires_at: null,
    scheduled_for: input.scheduledFor,
    started_at: input.startedAt,
    ended_at: input.startedAt,
    status: 'dead_lettered',
    result_summary: null,
    error_summary: errorSummary,
    retry_count: retryCount,
    notified_at: null,
  });
  await input.deps.opsRepository.updateJob(input.currentJob.id, {
    status: 'dead_lettered',
    pause_reason: errorSummary,
    next_run: null,
    last_run: input.startedAt,
    consecutive_failures: retryCount,
    lease_run_id: null,
    lease_expires_at: null,
  });

  let boundTriggerId: string | undefined;
  let eventAppSession: SchedulerEventAppSession | undefined;
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
    boundTriggerId = boundTrigger?.triggerId;
    eventAppSession =
      (boundTrigger
        ? await resolveAppSessionForTrigger(
            boundTrigger.requestedBy,
            input.control,
          )
        : undefined) ??
      (await resolveAppSessionForJob(input.currentJob, input.control));
  } catch {
    // Best effort trigger binding should not hide the dead-lettered job state.
  }

  const publishRuntimeEvent = async (
    eventType: RuntimeEventType,
    payload: Record<string, unknown>,
  ) => {
    try {
      const eventAppId = eventAppSession?.appId ?? input.runtimeAppId;
      if (!eventAppId) return;
      await input.publishRuntimeEvent({
        appId: eventAppId as never,
        eventType,
        payload,
        actor: 'scheduler',
        sessionId: eventAppSession?.sessionId as never,
        jobId: input.currentJob.id as never,
        runId: input.runId as never,
        triggerId: boundTriggerId,
        responseMode: eventAppSession?.defaultResponseMode,
        webhookId: eventAppSession?.defaultWebhookId,
      });
    } catch (err) {
      input.logger.warn(
        { err, jobId: input.currentJob.id, runId: input.runId, eventType },
        'Failed to write unresolved scheduler execution event',
      );
    }
  };

  await publishRuntimeEvent(RUNTIME_EVENT_TYPES.JOB_RUN_STARTED, {
    jobId: input.currentJob.id,
    runId: input.runId,
    scheduledFor: input.scheduledFor,
  });
  await publishRuntimeEvent(runtimeEventTypeForRunStatus('dead_lettered'), {
    next_run: null,
    retry_count: retryCount,
    pause_reason: errorSummary,
  });

  const summary = errorSummary.slice(0, 240);
  const notified = await notifySchedulerTerminalRunState({
    job: input.currentJob,
    runId: input.runId,
    runStatus: 'dead_lettered',
    summary,
    nextRun: null,
    retryCount,
    pauseReason: errorSummary,
    durationMs: Math.max(0, nowMs() - input.startedAtMs),
    sendMessage: input.deps.sendMessage,
  });
  if (notified) await input.deps.opsRepository.markJobRunNotified(input.runId);
  await publishRuntimeEvent(RUNTIME_EVENT_TYPES.JOB_FAILED, {
    status: 'dead_lettered',
    delivery_state: notified ? 'sent' : 'not_sent',
    start_notification_state: 'not_sent',
    next_run: null,
    retry_count: retryCount,
    pause_reason: errorSummary,
    notified,
    summary,
  });

  await publishSchedulerRunCompletion({
    currentJob: input.currentJob,
    runId: input.runId,
    runStatus: 'dead_lettered',
    notified,
    startNotified: false,
    summary,
    nextRun: null,
    boundTriggerId,
    eventAppSession,
    resolveEventAppSession: () =>
      resolveAppSessionForJob(input.currentJob, input.control),
    markTriggerCompleted: (status) =>
      input.control.markTriggerCompleted(boundTriggerId!, status),
    publishRuntimeEvent: async (event) => {
      await input.publishRuntimeEvent(event);
    },
    runtimeAppId: input.runtimeAppId,
    logger: input.logger,
  });
  input.deps.onSchedulerChanged?.(input.currentJob.id);
}
