import { randomUUID } from 'crypto';
import fs from 'fs';
import { ASSISTANT_NAME, getEffectiveModelConfig } from '../config/index.js';
import type { Job, JobExecutionMode } from '../domain/types.js';
import { logger } from '../infrastructure/logging/logger.js';
import {
  getRuntimeControlRepository,
  getRuntimeEventExchange,
} from '../adapters/storage/postgres/runtime-store.js';
import { resolveJobRuntimeAppId } from '../application/jobs/job-access.js';
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
} from '../runtime/session-resume-runtime.js';
import {
  collectCompactBoundaryMemory,
  collectJobCompletionMemory,
} from './compact-memory.js';
import { normalizeCleanupAfterMs } from './cleanup.js';
import {
  resolveExecutionContext,
  resolveExecutionMemoryContext,
} from './execution-context.js';
import { computeNextJobRun } from './schedule-math.js';
import {
  logMemoryDreamJobFailure,
  notifySchedulerRunFailure,
} from './execution-notifications.js';
import { handleSystemJob, MEMORY_DREAM_SYSTEM_PROMPT } from './system-jobs.js';
import {
  buildJobStreamingOptions,
  nextJobStreamingGeneration,
} from './streaming-options.js';
export { resetJobStreamingGenerationForTests as resetSchedulerExecutionStateForTests } from './streaming-options.js';
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
const JOB_DELETION_CHECK_INTERVAL_MS = 1_000;
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

  const groups = deps.registeredGroups();
  const execution = resolveExecutionContext(currentJob, groups);
  if (!execution) {
    await deps.opsRepository.updateJob(currentJob.id, {
      status: 'dead_lettered',
      pause_reason: `Group scope not found: ${currentJob.group_scope}`,
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
  const runtimeAppId = resolveJobRuntimeAppId(currentJob);
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
  let jobDeletedDuringRun = false;
  let lastJobDeletionCheckAt = 0;
  let firstDeliveryDeletionCheckDone = false;
  const isJobDeleted = async (force = false): Promise<boolean> => {
    if (jobDeletedDuringRun) return true;
    const now = currentTimeMs();
    if (
      !force &&
      now - lastJobDeletionCheckAt < JOB_DELETION_CHECK_INTERVAL_MS
    ) {
      return false;
    }
    lastJobDeletionCheckAt = now;
    let jobStillExists: boolean;
    try {
      jobStillExists = Boolean(
        await deps.opsRepository.getJobById(currentJob.id),
      );
    } catch (err) {
      jobDeletedDuringRun = true;
      logger.debug(
        { jobId: currentJob.id, runId, err },
        'Scheduler run observed closed storage while checking job state',
      );
      return true;
    }
    if (jobStillExists) return false;
    jobDeletedDuringRun = true;
    logger.info(
      { jobId: currentJob.id, runId },
      'Scheduler job deleted while run was active',
    );
    return true;
  };
  const shouldSuppressDelivery = async (): Promise<boolean> => {
    const force = !firstDeliveryDeletionCheckDone;
    firstDeliveryDeletionCheckDone = true;
    return isJobDeleted(force);
  };
  const emitJobEvent = async (
    eventType: RuntimeEventType,
    payload: Record<string, unknown> | null,
  ): Promise<void> => {
    if (await isJobDeleted(true)) return;
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
  let collectedResult = '';
  let latestUsage: NormalizedModelUsage | undefined;
  try {
    const groupDir = resolveGroupFolderPath(execution.group.folder);
    fs.mkdirSync(groupDir, { recursive: true });
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const isMain = execution.group.isMain === true;
  const linkedSessions = Array.from(new Set(currentJob.linked_sessions));
  const shouldDeliverToChat = !currentJob.silent && linkedSessions.length > 0;
  const streamGeneration = nextJobStreamingGeneration();
  const buildStreamingOptions = (done?: boolean) =>
    buildJobStreamingOptions({
      generation: streamGeneration,
      threadId: currentJob.thread_id,
      done,
    });
  const resetDeliveryStreams = () => {
    if (!deps.resetStreaming || !shouldDeliverToChat) return;
    for (const jid of linkedSessions) {
      try {
        deps.resetStreaming(jid);
      } catch (err) {
        logger.debug(
          { err, jid, jobId: currentJob.id },
          'Failed to reset scheduler stream state',
        );
      }
    }
  };
  const deliverMessage = async (text: string): Promise<boolean> => {
    if (!shouldDeliverToChat || !text || (await shouldSuppressDelivery()))
      return false;
    const options = currentJob.thread_id
      ? { threadId: currentJob.thread_id }
      : undefined;
    let delivered = false;
    for (const jid of linkedSessions) {
      try {
        await (options
          ? deps.sendMessage(jid, text, options)
          : deps.sendMessage(jid, text));
        delivered = true;
      } catch (err) {
        logger.warn(
          { jobId: currentJob.id, jid, err },
          'Failed to deliver scheduler message',
        );
      }
    }
    return delivered;
  };
  const deliverStreamingChunk = async (text: string): Promise<boolean> => {
    if (!shouldDeliverToChat || !text || (await shouldSuppressDelivery()))
      return false;
    if (!deps.sendStreamingChunk) {
      return deliverMessage(text);
    }

    let delivered = false;
    for (const jid of linkedSessions) {
      try {
        const accepted = await deps.sendStreamingChunk(
          jid,
          text,
          buildStreamingOptions(),
        );
        if (accepted) delivered = true;
      } catch (err) {
        logger.warn(
          { jobId: currentJob.id, jid, err },
          'Failed to deliver scheduler stream chunk',
        );
      }
    }
    return delivered;
  };
  let streamFinalized = false;
  const finalizeStreaming = async (): Promise<boolean> => {
    if (
      !shouldDeliverToChat ||
      !deps.sendStreamingChunk ||
      streamFinalized ||
      (await shouldSuppressDelivery())
    ) {
      return false;
    }
    streamFinalized = true;
    let delivered = false;
    for (const jid of linkedSessions) {
      try {
        const accepted = await deps.sendStreamingChunk(
          jid,
          '',
          buildStreamingOptions(true),
        );
        if (accepted) delivered = true;
      } catch (err) {
        logger.warn(
          { jobId: currentJob.id, jid, err },
          'Failed to finalize scheduler stream',
        );
      }
    }
    return delivered;
  };
  const { memoryDefaultScope, memoryUserId } = resolveExecutionMemoryContext({
    conversationKind: execution.group.conversationKind,
    executionJid: execution.executionJid,
  });
  if (shouldDeliverToChat) {
    resetDeliveryStreams();
    await deliverMessage(`🔔 Scheduled task: ${currentJob.name}`);
    firstDeliveryDeletionCheckDone = false;
  }

  if (!error && currentJob.prompt.startsWith('__system:')) {
    try {
      const systemResult = await handleSystemJob(
        currentJob,
        execution.group.folder,
      );
      result = JSON.stringify(systemResult);
      collectedResult = result;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  } else {
    if (!error) {
      let deliveredAnyOutput = false;
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
        turnContext = await deps.opsRepository.getAgentTurnContext?.({
          groupFolder: execution.group.folder,
          chatJid: execution.executionJid,
          threadId: currentJob.thread_id ?? null,
        });
        const effectiveAllowedTools = await resolveExecutionAllowedTools({
          job: currentJob,
          appId: turnContext?.appId ?? runtimeAppId,
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
            threadId: currentJob.thread_id || undefined,
            persona: execution.group.agentConfig?.persona,
            memoryUserId,
            memoryDefaultScope,
            isMain,
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
              result = streamedOutput.result;
              collectedResult += streamedOutput.result;
              const chunkChars = streamedOutput.result.length;
              bufferedStreamingChars += chunkChars;
              totalStreamingChars += chunkChars;
              flushStreamingEvent();
              if (await deliverStreamingChunk(streamedOutput.result)) {
                deliveredAnyOutput = true;
              }
            }
            if (streamedOutput.status === 'success' && !streamedOutput.usage) {
              if (await finalizeStreaming()) deliveredAnyOutput = true;
            }
            if (streamedOutput.status === 'error') {
              error = streamedOutput.error || 'Unknown error';
              if (await finalizeStreaming()) deliveredAnyOutput = true;
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
        } else if (output.result) {
          result = output.result;
          if (!collectedResult) collectedResult = output.result;
        }
        if (!error) {
          await completeSuccessfulRuntimeSessionRun({
            ops: deps.opsRepository,
            group: execution.group,
            agentSessionId: turnContext?.agentSessionId,
            runId: agentRunId,
            result: output.result,
          });
          await collectJobCompletionMemory({
            agentSessionId: turnContext?.agentSessionId,
            collectMemory: deps.collectSessionMemory,
            defaultScope: memoryDefaultScope,
            prompt: currentJob.prompt,
            result: result || collectedResult || output.result,
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

        if (!error) {
          const fallbackText = result || collectedResult;
          if (fallbackText && !deliveredAnyOutput) {
            if (await deliverMessage(fallbackText)) {
              deliveredAnyOutput = true;
            }
          }
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        await completeFailedRuntimeSessionRun({
          ops: deps.opsRepository,
          runId: agentRunId,
          errorSummary: error,
        });
      } finally {
        await finalizeStreaming();
      }
    }
  }

  const now = currentIso();
  await isJobDeleted(true);
  if (jobDeletedDuringRun) {
    result = null;
    collectedResult = '';
    error = null;
  }
  const nextRunOnSuccess = computeNextJobRun(currentJob, scheduledFor);
  let runStatus: 'completed' | 'failed' | 'timeout' | 'dead_lettered' =
    'completed';
  let nextRun: string | null = nextRunOnSuccess;
  let retryCount = currentJob.consecutive_failures;
  let pauseReason: string | null = null;

  if (jobDeletedDuringRun) {
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
        pauseReason = `Paused after ${retryCount} failures. Last error: ${error}`;
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

  const resultSummary = result || collectedResult || null;
  await deps.opsRepository.completeJobRun(
    runId,
    runStatus,
    resultSummary ? resultSummary.slice(0, 500) : null,
    error ? error.slice(0, 500) : null,
  );

  await emitJobEvent(runtimeEventTypeForRunStatus(runStatus), {
    next_run: nextRun,
    retry_count: retryCount,
    pause_reason: pauseReason,
  });
  if (error?.includes('tool not on autonomous job allowlist'))
    await emitJobEvent(RUNTIME_EVENT_TYPES.JOB_TOOL_DENIED, {
      error_summary: error.slice(0, 500),
    });

  const summary = error
    ? error.slice(0, 240)
    : resultSummary
      ? resultSummary.slice(0, 4000)
      : 'Completed';
  logMemoryDreamJobFailure({ job: currentJob, runId, error, logger });
  const notified =
    runStatus === 'completed'
      ? false
      : await notifySchedulerRunFailure({
          job: currentJob,
          runId,
          runStatus,
          summary,
          nextRun,
          retryCount,
          pauseReason,
          sendMessage: deps.sendMessage,
          deliverMessage,
          error,
        });
  if (notified) {
    await deps.opsRepository.markJobRunNotified(runId);
  }
  await emitJobEvent(
    runStatus === 'completed'
      ? RUNTIME_EVENT_TYPES.JOB_COMPLETED
      : RUNTIME_EVENT_TYPES.JOB_FAILED,
    {
      status: runStatus,
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
    !jobDeletedDuringRun &&
    currentJob.schedule_type === 'once' &&
    (runStatus === 'completed' || runStatus === 'dead_lettered') &&
    normalizeCleanupAfterMs(currentJob.cleanup_after_ms) === 0
  ) {
    await deps.opsRepository.deleteJob(currentJob.id);
    deps.onSchedulerChanged?.(currentJob.id);
  }
}
