import { randomUUID } from 'crypto';
import fs from 'fs';
import { ASSISTANT_NAME, getEffectiveModelConfig } from '../config/index.js';
import type { Job } from '../domain/types.js';
import { logger } from '../infrastructure/logging/logger.js';
import {
  getRuntimeControlRepository,
  getRuntimeEventExchange,
} from '../adapters/storage/postgres/runtime-store.js';
import { DEFAULT_JOB_RUNTIME_APP_ID } from '../application/jobs/job-access.js';
import {
  agentIdForJobGroupScope,
  resolveJobToolPolicy,
} from '../application/jobs/job-tool-policy.js';
import {
  RUNTIME_EVENT_TYPES,
  type RuntimeEventType,
} from '../domain/events/runtime-event-types.js';
import { nowIso, nowMs, toIso } from '../shared/time/datetime.js';
import { resolveGroupFolderPath } from '../platform/group-folder.js';
import { AgentOutput, spawnAgent } from '../runtime/agent-spawn.js';
import {
  buildRuntimeRunOptions,
  completeFailedRuntimeSessionRun,
  completeSuccessfulRuntimeSessionRun,
  createRuntimeUserVisibleResultAccumulator,
} from '../runtime/session-resume-runtime.js';
import {
  resolveTurnSelectedMcpServerIds,
  resolveTurnSelectedSkillIds,
} from '../runtime/group-run-context.js';
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
import {
  logMemoryDreamJobFailure,
  notifySchedulerRunStart,
  notifySchedulerTerminalRunState,
} from './execution-notifications.js';
import { deadLetterUnresolvedExecutionContext } from './execution-dead-letter.js';
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
import { parseAutonomousToolDenial } from '../shared/autonomous-tool-denial.js';
import {
  resolveAppSessionForJob,
  resolveAppSessionForTrigger,
  type SchedulerEventAppSession,
} from './app-session-resolution.js';
import { publishSchedulerRunCompletion } from './execution-completion-events.js';
import type {
  JobTurnContext,
  SchedulerDependencies,
  SchedulerDispatchPayload,
} from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export async function runJob(
  job: Job,
  deps: SchedulerDependencies,
  queueJid: string,
  dispatch?: SchedulerDispatchPayload,
): Promise<void> {
  const runAgentImpl = deps.runAgent ?? spawnAgent;
  const currentJob = await deps.opsRepository.getJobById(job.id);
  if (!currentJob || currentJob.status !== 'active') return;
  const scheduledFor =
    dispatch?.scheduledFor || currentJob.next_run || nowIso();
  const runId = dispatch?.runId ?? randomUUID();
  const startedAtMs = nowMs();
  const startedAt = toIso(startedAtMs);
  const runtimeAppId = DEFAULT_JOB_RUNTIME_APP_ID;
  const groups = deps.conversationRoutes();
  const execution = resolveExecutionContext(currentJob, groups);
  if (!execution) {
    await deadLetterUnresolvedExecutionContext({
      currentJob,
      deps,
      runId,
      scheduledFor,
      startedAt,
      startedAtMs,
      dispatch,
      runtimeAppId,
      control: getRuntimeControlRepository(),
      publishRuntimeEvent: async (event) => {
        await getRuntimeEventExchange().publish(event);
      },
      logger,
    });
    return;
  }
  const timeoutMs = Math.max(30_000, currentJob.timeout_ms || 300_000);
  const leaseExpiresAt = toIso(nowMs() + timeoutMs + 30_000);
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
  const claimedRun = await deps.opsRepository.getJobRunById(runId);
  const runShortId = claimedRun?.short_id ?? null;
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
          short_id: runShortId,
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
    nowMs,
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
    scheduled_for: scheduledFor,
    timeout_ms: timeoutMs,
    ...jobStartedModelPayload(resolvedModel),
  });
  let result: string | null = null;
  let error: string | null = null;
  const resultSummaryAccumulator = createRuntimeUserVisibleResultAccumulator();
  let hasStreamedResult = false;
  const appendResultSummary = (delta: string | null | undefined): void => {
    if (!delta) return;
    resultSummaryAccumulator.append(delta);
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
    startNotified = await notifySchedulerRunStart({
      job: currentJob,
      runId,
      runShortId,
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
      let latestProviderSessionId: string | undefined;
      const persistedProviderSessionIds = new Set<string>();
      const flushStreamingEvent = (force = false): void => {
        if (bufferedStreamingChars <= 0) return;
        const timestampMs = nowMs();
        if (!force && timestampMs - lastStreamingEventMs < 1000) return;
        void emitJobEvent(RUNTIME_EVENT_TYPES.JOB_STREAMING, {
          buffered_chars: bufferedStreamingChars,
          total_chars: totalStreamingChars,
        });
        bufferedStreamingChars = 0;
        lastStreamingEventMs = timestampMs;
      };
      try {
        turnContext = await deps.opsRepository.getAgentTurnContext?.(
          buildExecutionTurnContextInput({
            agentFolder: execution.group.folder,
            executionJid: execution.executionJid,
            threadId: execution.threadId,
            conversationKind: execution.group.conversationKind,
            memoryUserId,
            jobId: currentJob.id,
            query: currentJob.prompt,
          }),
        );
        const executionAppId =
          turnContext?.appId ?? eventAppSession?.appId ?? runtimeAppId;
        const executionAgentId =
          turnContext?.agentId ??
          agentIdForJobGroupScope(execution.group.folder);
        const [
          toolPolicy,
          selectedSkillIds,
          selectedMcpServerIds,
          credentialBroker,
        ] = await Promise.all([
          resolveJobToolPolicy({
            job: currentJob,
            appId: executionAppId,
            agentId: executionAgentId,
            toolRepository: deps.getToolRepository?.(),
          }),
          resolveTurnSelectedSkillIds(deps, {
            appId: executionAppId,
            agentId: executionAgentId,
          }),
          resolveTurnSelectedMcpServerIds(deps, {
            appId: executionAppId,
            agentId: executionAgentId,
          }),
          deps.getCredentialBroker?.() ?? Promise.resolve(undefined),
        ]);
        const runOptions = buildRuntimeRunOptions({
          timeoutMs,
          credentialBroker,
          skillRepository: deps.getSkillRepository?.(),
          skillArtifactStore: deps.getSkillArtifactStore?.(),
          mcpServerRepository: deps.getMcpServerRepository?.(),
          mcpHostnameLookup: deps.getMcpHostnameLookup?.(),
          mcpDnsValidationCache: deps.getMcpDnsValidationCache?.(),
          skillContext: {
            appId: executionAppId,
            agentId: executionAgentId,
          },
        });
        agentRunId = turnContext?.agentSessionId
          ? await deps.opsRepository.createSessionAgentRun?.({
              agentSessionId: turnContext.agentSessionId,
              cause: 'job',
            })
          : undefined;
        const persistProviderSessionId = async (
          providerSessionId: string | undefined,
        ): Promise<void> => {
          if (
            !providerSessionId ||
            !turnContext?.agentSessionId ||
            persistedProviderSessionIds.has(providerSessionId)
          ) {
            return;
          }
          const persisted = await deps.opsRepository.setSession(
            execution.group.folder,
            providerSessionId,
            execution.threadId,
            {
              conversationJid: execution.executionJid,
              conversationKind: execution.group.conversationKind,
              memoryUserId,
              jobId: currentJob.id,
              expectedAgentSessionId: turnContext.agentSessionId,
              expectedAgentSessionResetAt:
                turnContext.agentSessionResetAt ?? null,
            },
          );
          if (persisted === false) return;
          persistedProviderSessionIds.add(providerSessionId);
        };
        const output = await runAgentImpl(
          execution.group,
          {
            prompt: currentJob.prompt,
            model: resolvedModel.selectedModel,
            groupFolder: execution.group.folder,
            chatJid: execution.executionJid,
            threadId: execution.threadId || undefined,
            appId: executionAppId,
            agentId: executionAgentId,
            persona: execution.group.agentConfig?.persona,
            memoryUserId,
            memoryDefaultScope,
            isScheduledJob: true,
            jobId: currentJob.id,
            runId,
            jobModelUseKind,
            assistantName: ASSISTANT_NAME,
            memoryContextBlock: turnContext?.memoryContextBlock,
            allowedTools: toolPolicy.effectiveAllowedTools,
            selectedSkillIds,
            selectedMcpServerIds,
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
            if (streamedOutput.runtimeEvents?.length) {
              for (const event of streamedOutput.runtimeEvents) {
                if (event.eventType !== RUNTIME_EVENT_TYPES.JOB_HEARTBEAT)
                  continue;
                await emitJobEvent(RUNTIME_EVENT_TYPES.JOB_HEARTBEAT, {
                  ...(isRecord(event.payload) ? event.payload : {}),
                });
              }
            }
            if (streamedOutput.usage) latestUsage = streamedOutput.usage;
            if (
              streamedOutput.status !== 'error' &&
              streamedOutput.newSessionId
            ) {
              latestProviderSessionId = streamedOutput.newSessionId;
              await persistProviderSessionId(streamedOutput.newSessionId);
            }
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
              appendResultSummary(streamedOutput.result);
              const chunkChars = streamedOutput.result.length;
              bufferedStreamingChars += chunkChars;
              totalStreamingChars += chunkChars;
              flushStreamingEvent();
            }
            if (streamedOutput.status === 'error') {
              error = streamedOutput.error || 'Unknown error';
            }
          },
          runOptions,
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
          appendResultSummary(output.result);
        }
        if (!error) {
          const boundedResultSummary = resultSummaryAccumulator.snapshot();
          await completeSuccessfulRuntimeSessionRun({
            ops: deps.opsRepository,
            group: execution.group,
            chatJid: execution.executionJid,
            threadId: execution.threadId,
            conversationKind: execution.group.conversationKind,
            memoryUserId,
            jobId: currentJob.id,
            agentSessionId: turnContext?.agentSessionId,
            agentSessionResetAt: turnContext?.agentSessionResetAt ?? null,
            providerSessionId: persistedProviderSessionIds.has(
              output.newSessionId ?? latestProviderSessionId ?? '',
            )
              ? undefined
              : (output.newSessionId ?? latestProviderSessionId),
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
  const now = nowIso();
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
  const policyToolDenial = parseAutonomousToolDenial(safeErrorSummary);
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
      if (policyToolDenial || exceededRetry || exceededConsecutive) {
        runStatus = 'dead_lettered';
        nextRun = null;
        pauseReason = policyToolDenial
          ? `Needs permission: ${policyToolDenial.toolName}`
          : `Paused after ${retryCount} failures. Last error: ${safeErrorSummary || 'Unknown error'}`;
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
        nextRun = toIso(nowMs() + boundedDelay);
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
  const safeResultSummary = resultSummary ? resultSummary : null;
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
  const toolDenial = policyToolDenial;
  if (toolDenial)
    await emitJobEvent(RUNTIME_EVENT_TYPES.JOB_TOOL_DENIED, {
      error_summary: safeErrorSummary ? safeErrorSummary.slice(0, 500) : null,
      denied_tool: toolDenial.toolName,
      recovery_action: toolDenial.recoveryAction ?? null,
      recovery_kind: toolDenial.recoveryAction?.startsWith('request_permission')
        ? 'persistent_capability'
        : 'job_policy',
    });
  const summary = safeErrorSummary
    ? safeErrorSummary.slice(0, 240)
    : safeResultSummary
      ? safeResultSummary.slice(0, 240)
      : 'Completed, no reportable output.';
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
      durationMs: Math.max(0, nowMs() - startedAtMs),
      runShortId,
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
  const control = getRuntimeControlRepository();
  eventAppSession = await publishSchedulerRunCompletion({
    currentJob,
    runId,
    runStatus,
    notified,
    startNotified,
    summary,
    nextRun,
    boundTriggerId,
    eventAppSession,
    resolveEventAppSession: () => resolveAppSessionForJob(currentJob, control),
    markTriggerCompleted: (status) =>
      control.markTriggerCompleted(boundTriggerId!, status),
    publishRuntimeEvent: async (event) => {
      await getRuntimeEventExchange().publish(event);
    },
    runtimeAppId,
    logger,
  });
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
