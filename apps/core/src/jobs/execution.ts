import { randomUUID } from 'crypto';
import fs from 'fs';
import { ASSISTANT_NAME, getEffectiveModelConfig } from '../config/index.js';
import type { Job, JobExecutionMode } from '../domain/types.js';
import { logger } from '../infrastructure/logging/logger.js';
import {
  getRuntimeControlRepository,
  getRuntimeEventExchange,
} from '../adapters/storage/postgres/runtime-store.js';
import { DEFAULT_JOB_RUNTIME_APP_ID } from '../application/jobs/job-access.js';
import { agentIdForJobGroupScope } from '../application/jobs/job-tool-policy.js';
import {
  RUNTIME_EVENT_TYPES,
  type RuntimeEventType,
} from '../domain/events/runtime-event-types.js';
import {
  nowIso as currentIso,
  nowMs as currentTimeMs,
  toIso,
} from '../infrastructure/time/datetime.js';
import { resolveGroupFolderPath } from '../platform/group-folder.js';
import { AgentOutput, spawnAgent } from '../runtime/agent-spawn.js';
import {
  completeFailedRuntimeSessionRun,
  completeSuccessfulRuntimeSessionRun,
  createRuntimeResultSummaryAccumulator,
} from '../runtime/session-resume-runtime.js';
import { redactProviderSessionHandlesInText } from '../shared/provider-session-redaction.js';
import {
  collectCompactBoundaryMemory,
  collectJobCompletionMemory,
} from './compact-memory.js';
import { normalizeCleanupAfterMs } from './cleanup.js';
import {
  buildExecutionTurnContextInput,
  resolveExecutionContext,
  resolveExecutionMemoryContext,
} from './execution-context.js';
import { computeNextJobRun } from './schedule-math.js';
import { isDeliverySent, settleDeliveryAttempt } from './delivery.js';
import {
  resolveJobNotificationRoutes,
  type NormalizedJobNotificationRoute,
} from './job-notification-routes.js';
import {
  logMemoryDreamJobFailure,
  notifySchedulerRunStart,
  notifySchedulerTerminalRunState,
} from './execution-notifications.js';
import { handleSystemJob } from './system-jobs.js';
import { createJobExecutionDeletionGuard } from './execution-deletion-guard.js';
import { runtimeEventTypeForRunStatus } from './run-status-event.js';
import {
  jobCompletedModelPayload,
  jobStartedModelPayload,
  modelUseKindForJobSchedule,
  resolveJobModel,
  type NormalizedModelUsage,
} from './model-resolution.js';
import { resolveExecutionAllowedTools } from './execution-tool-policy.js';
import {
  resolveAppSessionForJob,
  resolveAppSessionForTrigger,
  type SchedulerEventAppSession,
} from './app-session-resolution.js';
import type {
  JobTurnContext,
  SchedulerDependencies,
  SchedulerDispatchPayload,
} from './types.js';

export function resetSchedulerExecutionStateForTests(): void {}
export async function runJob(
  job: Job,
  deps: SchedulerDependencies,
  queueJid: string,
  executionModeHint?: JobExecutionMode,
  dispatch?: SchedulerDispatchPayload,
): Promise<void> {
  const runAgentImpl = deps.runAgent ?? spawnAgent;
  const currentJob = await deps.opsRepository.getJobById(job.id);
  if (!currentJob || currentJob.status !== 'active') {
    return;
  }

  const groups = deps.conversationRoutes();
  const execution = resolveExecutionContext(currentJob, groups);
  if (!execution) {
    const unresolvedConversation =
      currentJob.execution_context?.conversationJid || 'unknown';
    await deps.opsRepository.updateJob(currentJob.id, {
      status: 'dead_lettered',
      pause_reason: `Execution context route not found: ${unresolvedConversation}`,
      next_run: null,
    });
    deps.onSchedulerChanged?.(currentJob.id);
    return;
  }
  const scheduledFor =
    dispatch?.scheduledFor || currentJob.next_run || currentIso();
  const runId = dispatch?.runId ?? randomUUID();
  const startedAt = currentIso();
  const timeoutMs = Math.max(30_000, currentJob.timeout_ms || 300_000);
  const executionMode: JobExecutionMode =
    (executionModeHint ?? currentJob.execution_mode) === 'serialized'
      ? 'serialized'
      : 'parallel';
  const leaseExpiresAt = toIso(currentTimeMs() + timeoutMs + 30_000);
  const runtimeAppId = DEFAULT_JOB_RUNTIME_APP_ID;
  const jobModelUseKind = modelUseKindForJobSchedule(currentJob.schedule_type);
  const resolvedModel = resolveJobModel(
    currentJob,
    getEffectiveModelConfig(undefined, jobModelUseKind, execution.group.folder),
  );
  const claimed = await deps.opsRepository.claimDueJobRunStart({
    jobId: currentJob.id,
    runId,
    scheduledFor,
    startedAt,
    retryCount: currentJob.consecutive_failures,
    leaseExpiresAt,
    requireNextRun:
      currentJob.schedule_type !== 'manual' && !dispatch?.triggerId,
  });
  if (!claimed) return;
  let boundTriggerId: string | undefined;
  let eventAppSession: SchedulerEventAppSession;
  try {
    const control = getRuntimeControlRepository();
    const boundTrigger = dispatch?.triggerId
      ? await control.bindTriggerToRun(dispatch.triggerId, runId)
      : await control.bindPendingTriggerToRun(currentJob.id, runId);
    boundTriggerId = boundTrigger?.triggerId;
    eventAppSession =
      (boundTrigger
        ? await resolveAppSessionForTrigger(boundTrigger.requestedBy, control)
        : undefined) ?? (await resolveAppSessionForJob(currentJob, control));
    const startEventAppId = eventAppSession?.appId ?? runtimeAppId;
    if (startEventAppId) {
      await getRuntimeEventExchange().publish({
        appId: startEventAppId as never,
        eventType: RUNTIME_EVENT_TYPES.JOB_RUN_STARTED,
        payload: {
          jobId: currentJob.id,
          runId,
          scheduledFor,
        },
        actor: 'scheduler',
        sessionId: eventAppSession?.sessionId as never,
        jobId: currentJob.id as never,
        runId: runId as never,
        triggerId: boundTrigger?.triggerId,
        responseMode: eventAppSession?.defaultResponseMode,
        webhookId: eventAppSession?.defaultWebhookId,
      });
    }
  } catch {} // eslint-disable-line no-empty
  const deletionGuard = createJobExecutionDeletionGuard({
    jobId: currentJob.id,
    runId,
    nowMs: currentTimeMs,
    getJobById: (jobId) => deps.opsRepository.getJobById(jobId),
    log: logger,
  });
  const emitJobEvent = async (
    eventType: RuntimeEventType,
    payload: Record<string, unknown> | null,
  ): Promise<void> => {
    if (await deletionGuard.isJobDeleted(true)) return;
    try {
      const control = getRuntimeControlRepository();
      const appSession =
        eventAppSession ?? (await resolveAppSessionForJob(currentJob, control));
      const eventAppId = appSession?.appId ?? runtimeAppId;
      if (!eventAppId) return;
      await getRuntimeEventExchange().publish({
        appId: eventAppId as never,
        eventType,
        payload,
        actor: 'scheduler',
        sessionId: appSession?.sessionId as never,
        jobId: currentJob.id as never,
        runId: runId as never,
        triggerId: boundTriggerId,
        responseMode: appSession?.defaultResponseMode,
        webhookId: appSession?.defaultWebhookId,
      });
    } catch (err) {
      logger.warn(
        { err, jobId: currentJob.id, runId, eventType },
        'Failed to write scheduler lifecycle event',
      );
    }
  };
  await emitJobEvent(RUNTIME_EVENT_TYPES.JOB_STARTED, {
    queue_jid: queueJid,
    execution_mode: executionMode,
    scheduled_for: scheduledFor,
    timeout_ms: timeoutMs,
    ...jobStartedModelPayload(resolvedModel),
  });
  let result: string | null = null;
  let error: string | null = null;
  const resultSummaryAccumulator = createRuntimeResultSummaryAccumulator();
  const userVisibleFallbackAccumulator =
    createRuntimeResultSummaryAccumulator();
  let hasStreamedResult = false;
  let attemptedStreamingOutputDelivery = false;
  let streamedOutputDelivered = false;
  const appendResultSummary = (delta: string | null | undefined): void => {
    if (!delta) return;
    resultSummaryAccumulator.append(delta);
    result = resultSummaryAccumulator.snapshot();
  };
  const notificationRoutes = resolveJobNotificationRoutes(currentJob);
  const resetStreamingRoutes = (): void => {
    if (!deps.resetStreaming) return;
    for (const route of notificationRoutes) {
      try {
        deps.resetStreaming(route.conversationJid);
      } catch (err) {
        logger.warn(
          {
            err,
            jobId: currentJob.id,
            conversationJid: route.conversationJid,
          },
          'Failed to reset scheduler streaming state',
        );
      }
    }
  };
  const deliverStreamingChunk = async (
    route: NormalizedJobNotificationRoute,
    rawText: string,
    options: { done?: boolean } = {},
  ): Promise<boolean> => {
    const sendStreamingChunk = deps.sendStreamingChunk;
    if (!sendStreamingChunk) return false;
    const safeText = redactProviderSessionHandlesInText(rawText);
    const settlement = await settleDeliveryAttempt(
      () =>
        sendStreamingChunk(route.conversationJid, safeText, {
          ...(route.threadId ? { threadId: route.threadId } : {}),
          ...(options.done ? { done: true } : {}),
        }),
      { scope: 'job-streaming-output', target: route.conversationJid },
    ).catch((err) => {
      logger.warn(
        {
          err,
          jobId: currentJob.id,
          runId,
          conversationJid: route.conversationJid,
          done: options.done === true,
        },
        'Failed to send scheduler streaming output',
      );
      return 'not_delivered' as const;
    });
    return isDeliverySent(settlement);
  };
  const deliverFullResultFallback = async (text: string): Promise<boolean> => {
    if (!text.trim() || notificationRoutes.length === 0) return false;
    let delivered = false;
    for (const route of notificationRoutes) {
      try {
        const settlement = await settleDeliveryAttempt(
          () =>
            deps.sendMessage(
              route.conversationJid,
              text,
              route.threadId ? { threadId: route.threadId } : undefined,
            ),
          { scope: 'job-output-fallback', target: route.conversationJid },
        );
        if (isDeliverySent(settlement)) delivered = true;
      } catch (err) {
        logger.warn(
          {
            err,
            jobId: currentJob.id,
            runId,
            conversationJid: route.conversationJid,
          },
          'Failed to send scheduler full output fallback',
        );
      }
    }
    return delivered;
  };
  let latestUsage: NormalizedModelUsage | undefined;
  let startNotified = false;
  try {
    const groupDir = resolveGroupFolderPath(execution.group.folder);
    fs.mkdirSync(groupDir, { recursive: true });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const { memoryDefaultScope, memoryUserId } = resolveExecutionMemoryContext({
    conversationKind: execution.group.conversationKind,
    executionJid: execution.executionJid,
  });
  if (!(await deletionGuard.shouldSuppressDelivery())) {
    resetStreamingRoutes();
    startNotified = await notifySchedulerRunStart({
      job: currentJob,
      runId,
      sendMessage: deps.sendMessage,
    });
    deletionGuard.resetDeliveryDeletionCheck();
  }
  if (!error && currentJob.prompt.startsWith('__system:')) {
    try {
      const systemResult = await handleSystemJob(currentJob, {
        folder: execution.group.folder,
        conversationId: execution.executionJid,
        conversationKind: execution.group.conversationKind,
        userId: memoryUserId,
        threadId: execution.threadId,
      });
      appendResultSummary(JSON.stringify(systemResult));
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  } else {
    if (!error) {
      let bufferedStreamingChars = 0;
      let totalStreamingChars = 0;
      let lastStreamingEventMs = 0;
      let turnContext: JobTurnContext | undefined;
      let agentRunId: string | undefined;
      const flushStreamingEvent = (force = false): void => {
        if (bufferedStreamingChars <= 0) return;
        const nowMs = currentTimeMs();
        if (!force && nowMs - lastStreamingEventMs < 1000) return;
        void emitJobEvent(RUNTIME_EVENT_TYPES.JOB_STREAMING, {
          buffered_chars: bufferedStreamingChars,
          total_chars: totalStreamingChars,
        });
        bufferedStreamingChars = 0;
        lastStreamingEventMs = nowMs;
      };
      try {
        turnContext = await deps.opsRepository.getAgentTurnContext?.(
          buildExecutionTurnContextInput({
            agentFolder: execution.group.folder,
            executionJid: execution.executionJid,
            threadId: execution.threadId,
            conversationKind: execution.group.conversationKind,
            memoryUserId,
            query: currentJob.prompt,
          }),
        );
        const effectiveAllowedTools = await resolveExecutionAllowedTools({
          job: currentJob,
          appId: turnContext?.appId ?? eventAppSession?.appId ?? runtimeAppId,
          agentId:
            turnContext?.agentId ??
            agentIdForJobGroupScope(execution.group.folder),
          toolRepository: deps.getToolRepository?.(),
        });
        agentRunId = turnContext?.agentSessionId
          ? await deps.opsRepository.createSessionAgentRun?.({
              agentSessionId: turnContext.agentSessionId,
              cause: 'job',
            })
          : undefined;
        const output = await runAgentImpl(
          execution.group,
          {
            prompt: currentJob.prompt,
            model: resolvedModel.selectedModel,
            groupFolder: execution.group.folder,
            chatJid: execution.executionJid,
            threadId: execution.threadId || undefined,
            persona: execution.group.agentConfig?.persona,
            memoryUserId,
            memoryDefaultScope,
            isScheduledJob: true,
            jobModelUseKind,
            assistantName: ASSISTANT_NAME,
            script: currentJob.script || undefined,
            memoryContextBlock: turnContext?.memoryContextBlock,
            allowedTools: effectiveAllowedTools,
          },
          (proc, runHandle) =>
            deps.onProcess(
              queueJid,
              proc,
              runHandle,
              execution.group.folder,
              execution.stopAliasJids,
            ),
          async (streamedOutput: AgentOutput) => {
            if (streamedOutput.usage) latestUsage = streamedOutput.usage;
            await collectCompactBoundaryMemory({
              compactBoundary: streamedOutput.compactBoundary,
              agentSessionId: turnContext?.agentSessionId,
              collectMemory: deps.collectSessionMemory,
              defaultScope: memoryDefaultScope,
              logger,
              context: { jobId: currentJob.id, runId },
            });
            if (streamedOutput.result) {
              hasStreamedResult = true;
              userVisibleFallbackAccumulator.append(
                redactProviderSessionHandlesInText(streamedOutput.result),
              );
              appendResultSummary(streamedOutput.result);
              if (
                !currentJob.silent &&
                !(await deletionGuard.shouldSuppressDelivery())
              ) {
                for (const route of notificationRoutes) {
                  attemptedStreamingOutputDelivery = true;
                  if (
                    await deliverStreamingChunk(route, streamedOutput.result)
                  ) {
                    streamedOutputDelivered = true;
                  }
                }
                deletionGuard.resetDeliveryDeletionCheck();
              }
              const chunkChars = streamedOutput.result.length;
              bufferedStreamingChars += chunkChars;
              totalStreamingChars += chunkChars;
              flushStreamingEvent();
            }
            if (streamedOutput.status === 'error') {
              error = streamedOutput.error || 'Unknown error';
            }
          },
          { timeoutMs },
        );
        flushStreamingEvent(true);
        if (output.status === 'error') {
          error = output.error || 'Unknown error';
          await completeFailedRuntimeSessionRun({
            ops: deps.opsRepository,
            runId: agentRunId,
            errorSummary: error,
          });
        } else if (output.result && !hasStreamedResult) {
          userVisibleFallbackAccumulator.append(
            redactProviderSessionHandlesInText(output.result),
          );
          appendResultSummary(output.result);
        }
        if (hasStreamedResult && deps.sendStreamingChunk) {
          for (const route of notificationRoutes) {
            await deliverStreamingChunk(route, '', { done: true });
          }
        }
        if (!error) {
          const boundedResultSummary = resultSummaryAccumulator.snapshot();
          await completeSuccessfulRuntimeSessionRun({
            ops: deps.opsRepository,
            group: execution.group,
            agentSessionId: turnContext?.agentSessionId,
            runId: agentRunId,
            result: boundedResultSummary,
          });
          await collectJobCompletionMemory({
            agentSessionId: turnContext?.agentSessionId,
            collectMemory: deps.collectSessionMemory,
            defaultScope: memoryDefaultScope,
            prompt: currentJob.prompt,
            result: boundedResultSummary,
            logger,
            context: { jobId: currentJob.id, runId },
          });
        } else if (output.status !== 'error') {
          await completeFailedRuntimeSessionRun({
            ops: deps.opsRepository,
            runId: agentRunId,
            errorSummary: error,
          });
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        await completeFailedRuntimeSessionRun({
          ops: deps.opsRepository,
          runId: agentRunId,
          errorSummary: error,
        });
      }
    }
  }
  const now = currentIso();
  await deletionGuard.isJobDeleted(true);
  if (deletionGuard.deletedDuringRun) {
    result = null;
    error = null;
  }
  const nextRunOnSuccess = computeNextJobRun(currentJob, scheduledFor);
  let runStatus: 'completed' | 'failed' | 'timeout' | 'dead_lettered' =
    'completed';
  let nextRun: string | null = nextRunOnSuccess;
  let retryCount = currentJob.consecutive_failures;
  let pauseReason: string | null = null;
  const safeErrorSummary = error
    ? redactProviderSessionHandlesInText(error)
    : null;

  if (deletionGuard.deletedDuringRun) {
    nextRun = null;
  } else if (error) {
    retryCount += 1;
    runStatus = /timed out/i.test(error) ? 'timeout' : 'failed';
    if (currentJob.schedule_type === 'manual') {
      nextRun = null;
      await deps.opsRepository.updateJob(currentJob.id, {
        status: 'active',
        next_run: null,
        last_run: now,
        consecutive_failures: retryCount,
        pause_reason: null,
        lease_run_id: null,
        lease_expires_at: null,
      });
    } else {
      const exceededRetry = retryCount > currentJob.max_retries;
      const exceededConsecutive =
        retryCount >= currentJob.max_consecutive_failures;
      if (exceededRetry || exceededConsecutive) {
        runStatus = 'dead_lettered';
        nextRun = null;
        pauseReason = `Paused after ${retryCount} failures. Last error: ${safeErrorSummary || 'Unknown error'}`;
        await deps.opsRepository.updateJob(currentJob.id, {
          status: 'dead_lettered',
          next_run: null,
          last_run: now,
          consecutive_failures: retryCount,
          pause_reason: pauseReason,
          lease_run_id: null,
          lease_expires_at: null,
        });
      } else {
        const baseBackoff = Math.max(0, currentJob.retry_backoff_ms || 0);
        const exponent = Math.max(0, retryCount - 1);
        const cappedExponent = Math.min(exponent, 30);
        const multiplier = Math.max(1, 2 ** cappedExponent);
        const rawDelay = baseBackoff * multiplier;
        const boundedDelay = Number.isFinite(rawDelay)
          ? Math.min(rawDelay, 30 * 24 * 60 * 60 * 1000)
          : 30 * 24 * 60 * 60 * 1000;
        nextRun = toIso(currentTimeMs() + boundedDelay);
        await deps.opsRepository.updateJob(currentJob.id, {
          status: 'active',
          next_run: nextRun,
          last_run: now,
          consecutive_failures: retryCount,
          pause_reason: null,
          lease_run_id: null,
          lease_expires_at: null,
        });
      }
    }
  } else {
    await deps.opsRepository.updateJob(currentJob.id, {
      status:
        currentJob.schedule_type === 'manual' || nextRunOnSuccess
          ? 'active'
          : 'completed',
      next_run: nextRunOnSuccess,
      last_run: now,
      consecutive_failures: 0,
      pause_reason: null,
      lease_run_id: null,
      lease_expires_at: null,
    });
  }

  const resultSummary = deletionGuard.deletedDuringRun
    ? null
    : result || resultSummaryAccumulator.snapshot();
  const safeResultSummary = resultSummary
    ? redactProviderSessionHandlesInText(resultSummary)
    : null;
  const userVisibleFallbackSnapshot = userVisibleFallbackAccumulator.snapshot();
  let fullResultFallbackDelivered = false;
  if (
    runStatus === 'completed' &&
    !currentJob.silent &&
    !deletionGuard.deletedDuringRun &&
    !streamedOutputDelivered &&
    userVisibleFallbackSnapshot
  ) {
    fullResultFallbackDelivered = await deliverFullResultFallback(
      userVisibleFallbackSnapshot,
    );
  }
  if (attemptedStreamingOutputDelivery || fullResultFallbackDelivered) {
    resetStreamingRoutes();
  }
  await deps.opsRepository.completeJobRun(
    runId,
    runStatus,
    safeResultSummary ? safeResultSummary.slice(0, 500) : null,
    safeErrorSummary ? safeErrorSummary.slice(0, 500) : null,
  );

  await emitJobEvent(runtimeEventTypeForRunStatus(runStatus), {
    next_run: nextRun,
    retry_count: retryCount,
    pause_reason: pauseReason,
  });
  if (error?.includes('tool not on autonomous job allowlist'))
    await emitJobEvent(RUNTIME_EVENT_TYPES.JOB_TOOL_DENIED, {
      error_summary: safeErrorSummary ? safeErrorSummary.slice(0, 500) : null,
    });

  const summary = safeErrorSummary
    ? safeErrorSummary.slice(0, 240)
    : safeResultSummary
      ? safeResultSummary.slice(0, 240)
      : 'Completed';
  logMemoryDreamJobFailure({ job: currentJob, runId, error, logger });
  const notified =
    !(await deletionGuard.shouldSuppressDelivery()) &&
    (await notifySchedulerTerminalRunState({
      job: currentJob,
      runId,
      runStatus,
      summary,
      nextRun,
      retryCount,
      pauseReason,
      sendMessage: deps.sendMessage,
    }));
  if (notified) {
    await deps.opsRepository.markJobRunNotified(runId);
  }
  await emitJobEvent(
    runStatus === 'completed'
      ? RUNTIME_EVENT_TYPES.JOB_COMPLETED
      : RUNTIME_EVENT_TYPES.JOB_FAILED,
    {
      status: runStatus,
      delivery_state: notified ? 'sent' : 'not_sent',
      start_notification_state: startNotified ? 'sent' : 'not_sent',
      next_run: nextRun,
      retry_count: retryCount,
      pause_reason: pauseReason,
      notified,
      summary,
      ...jobCompletedModelPayload(resolvedModel, latestUsage),
    },
  );
  try {
    const control = getRuntimeControlRepository();
    eventAppSession =
      eventAppSession ?? (await resolveAppSessionForJob(currentJob, control));
    if (boundTriggerId) {
      await control.markTriggerCompleted(
        boundTriggerId,
        runStatus === 'completed' ? 'completed' : 'failed',
      );
    }
    const completionEventAppId = eventAppSession?.appId ?? runtimeAppId;
    if (completionEventAppId) {
      await getRuntimeEventExchange().publish({
        appId: completionEventAppId as never,
        eventType:
          runStatus === 'completed'
            ? RUNTIME_EVENT_TYPES.JOB_RUN_COMPLETED
            : RUNTIME_EVENT_TYPES.JOB_RUN_FAILED,
        payload: {
          jobId: currentJob.id,
          runId,
          status: runStatus,
          deliveryState: notified ? 'sent' : 'not_sent',
          startNotificationState: startNotified ? 'sent' : 'not_sent',
          summary,
          nextRun,
        },
        actor: 'scheduler',
        sessionId: eventAppSession?.sessionId as never,
        jobId: currentJob.id as never,
        runId: runId as never,
        triggerId: boundTriggerId,
        responseMode: eventAppSession?.defaultResponseMode,
        webhookId: eventAppSession?.defaultWebhookId,
      });
    }
  } catch {} // eslint-disable-line no-empty
  deps.onSchedulerChanged?.(currentJob.id);

  if (
    !deletionGuard.deletedDuringRun &&
    currentJob.schedule_type === 'once' &&
    (runStatus === 'completed' || runStatus === 'dead_lettered') &&
    normalizeCleanupAfterMs(currentJob.cleanup_after_ms) === 0
  ) {
    await deps.opsRepository.deleteJob(currentJob.id);
    deps.onSchedulerChanged?.(currentJob.id);
  }
}
