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
import * as jobToolPolicy from '../application/jobs/job-tool-policy.js';
import { SETUP_REQUIRED_PAUSE_REASON } from '../application/jobs/job-readiness-service.js';
import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
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
import {
  DEFAULT_RUNTIME_EXECUTION_PROVIDER_ID,
  resolveRuntimeExecutionProviderId,
} from '../runtime/execution-provider-id.js';
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
import {
  createJobRunDiagnostics,
  formatTerminalToolDenial,
  forwardRunnerRuntimeEvents,
  terminalDiagnosticsPayload,
} from './execution-diagnostics.js';
import { pauseJobForSetupIfNeeded } from './execution-readiness.js';
import {
  bindSchedulerRunEventState,
  createSchedulerJobEventEmitter,
  publishSchedulerCompletionEvent,
} from './execution-runtime-events.js';
import { resolveAppSessionForJob } from './app-session-resolution.js';
import { finalizeSchedulerJobRun } from './execution-finalization.js';
import { assertToolAccessRequirementsReadyForRun } from './execution-tool-access-requirements.js';
import { closeBrowserAfterJobRun } from './execution-browser-cleanup.js';
import { completeFailedRunFailsafe } from './run-failsafe.js';
import { createRunProviderMetadataUpdater } from './run-provider-metadata.js';
import type {
  JobTurnContext,
  SchedulerDependencies,
  SchedulerDispatchPayload,
} from './types.js';

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
  const eventControl = getRuntimeControlRepository();
  const preflightAppSession = await resolveAppSessionForJob(
    currentJob,
    eventControl,
  );
  const pausedForSetup = await pauseJobForSetupIfNeeded({
    currentJob,
    deps,
    executionAgentFolder: execution.group.folder,
    runtimeAppId,
    appSession: preflightAppSession,
    publishRuntimeEvent: async (event) => {
      await getRuntimeEventExchange().publish(event);
    },
  });
  if (pausedForSetup) return;
  const executionProviderId =
    deps.executionAdapter || !deps.runAgent
      ? resolveRuntimeExecutionProviderId(deps.executionAdapter)
      : DEFAULT_RUNTIME_EXECUTION_PROVIDER_ID;
  const claimed = await deps.opsRepository.claimDueJobRunStart({
    jobId: currentJob.id,
    runId,
    executionProviderId,
    workerId: execution.group.folder,
    leaseOwner: execution.executionJid,
    scheduledFor,
    startedAt,
    retryCount: currentJob.consecutive_failures,
    leaseExpiresAt,
    requireNextRun:
      currentJob.schedule_type !== 'manual' && !dispatch?.triggerId,
  });
  if (!claimed) return;
  let terminalRunRecorded = false;
  let deletedDuringRun = false;
  try {
    const claimedRun = await deps.opsRepository.getJobRunById(runId);
    const runShortId = claimedRun?.short_id ?? null;
    const eventState = await bindSchedulerRunEventState({
      currentJob,
      dispatch,
      runId,
      runShortId,
      scheduledFor,
      runtimeAppId,
      control: eventControl,
      publishRuntimeEvent: async (event) => {
        await getRuntimeEventExchange().publish(event);
      },
      logger,
    });
    const deletionGuard = createJobExecutionDeletionGuard({
      jobId: currentJob.id,
      runId,
      nowMs,
      getJobById: (jobId) => deps.opsRepository.getJobById(jobId),
      log: logger,
    });
    const emitJobEvent = createSchedulerJobEventEmitter({
      currentJob,
      runId,
      runtimeAppId,
      state: eventState,
      resolveEventAppSession: () =>
        resolveAppSessionForJob(currentJob, eventControl),
      publishRuntimeEvent: async (event) => {
        await getRuntimeEventExchange().publish(event);
      },
      deletionGuard,
      logger,
    });
    await emitJobEvent(RUNTIME_EVENT_TYPES.JOB_STARTED, {
      queue_jid: queueJid,
      scheduled_for: scheduledFor,
      timeout_ms: timeoutMs,
      ...jobStartedModelPayload(resolvedModel),
    });
    let result: string | null = null;
    let error: string | null = null;
    const diagnostics = createJobRunDiagnostics();
    let pausedForSetupDuringRun = false;
    const resultSummaryAccumulator =
      createRuntimeUserVisibleResultAccumulator();
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
        const systemResult: unknown = await handleSystemJob(currentJob, {
          folder: execution.group.folder,
          conversationId: execution.executionJid,
          conversationKind: execution.group.conversationKind,
          userId: memoryUserId,
          threadId: execution.threadId,
        });
        if (typeof systemResult !== 'string') {
          throw new Error('System job returned a non-displayable result.');
        }
        appendResultSummary(systemResult);
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
        const updateRunProviderMetadata = createRunProviderMetadataUpdater({
          opsRepository: deps.opsRepository,
          jobId: currentJob.id,
          outerRunId: runId,
          getSessionRunId: () => agentRunId,
          nowMs,
          logger,
        });
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
              executionProviderId,
              executionJid: execution.executionJid,
              threadId: execution.threadId,
              conversationKind: execution.group.conversationKind,
              memoryUserId,
              jobId: currentJob.id,
              query: currentJob.prompt,
            }),
          );
          if (turnContext?.providerSessionId) {
            await updateRunProviderMetadata({
              providerSessionId: turnContext.providerSessionId,
            });
          }
          const executionAppId =
            turnContext?.appId ??
            eventState.eventAppSession?.appId ??
            runtimeAppId;
          const executionAgentId =
            turnContext?.agentId ??
            jobToolPolicy.agentIdForJobGroupScope(execution.group.folder);
          const [toolPolicy, selectedSkillIds, credentialBroker] =
            await Promise.all([
              jobToolPolicy.resolveJobToolPolicy({
                job: currentJob,
                appId: executionAppId,
                agentId: executionAgentId,
                toolRepository: deps.getToolRepository?.(),
                skillRepository: deps.getSkillRepository?.(),
              }),
              resolveTurnSelectedSkillIds(deps, {
                appId: executionAppId,
                agentId: executionAgentId,
              }),
              deps.getCredentialBroker?.() ?? Promise.resolve(undefined),
            ]);
          const selectedMcpServerIds = await resolveTurnSelectedMcpServerIds(
            deps,
            {
              appId: executionAppId,
              agentId: executionAgentId,
            },
            toolPolicy.effectiveAllowedTools,
          );
          const toolAccessRequirementPreflight =
            await assertToolAccessRequirementsReadyForRun({
              toolAccessRequirements: currentJob.tool_access_requirements ?? [],
              effectiveAllowedTools: toolPolicy.effectiveAllowedTools,
              emitJobEvent,
            });
          const finalReadinessPassed = !(await pauseJobForSetupIfNeeded({
            currentJob,
            deps,
            executionAgentFolder: execution.group.folder,
            runtimeAppId,
            appSession: eventState.eventAppSession ?? preflightAppSession,
            agentId: executionAgentId,
            publishRuntimeEvent: async (event) => {
              await getRuntimeEventExchange().publish(event);
            },
          }));
          if (!finalReadinessPassed) {
            pausedForSetupDuringRun = true;
            error = SETUP_REQUIRED_PAUSE_REASON;
          } else {
            const runOptions = buildRuntimeRunOptions({
              timeoutMs,
              credentialBroker,
              skillRepository: deps.getSkillRepository?.(),
              skillArtifactStore: deps.getSkillArtifactStore?.(),
              mcpServerRepository: deps.getMcpServerRepository?.(),
              capabilitySecretRepository:
                deps.getCapabilitySecretRepository?.(),
              mcpHostnameLookup: deps.getMcpHostnameLookup?.(),
              mcpDnsValidationCache: deps.getMcpDnsValidationCache?.(),
              publishRuntimeEvent: async (event) => {
                await getRuntimeEventExchange().publish(event);
              },
              executionAdapter: deps.executionAdapter,
              skillContext: {
                appId: executionAppId,
                agentId: executionAgentId,
              },
            });
            agentRunId = turnContext?.agentSessionId
              ? await deps.opsRepository.createSessionAgentRun?.({
                  agentSessionId: turnContext.agentSessionId,
                  executionProviderId,
                  providerSessionId: turnContext.providerSessionId,
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
                appId: executionAppId,
                agentId: executionAgentId,
                persona: execution.group.agentConfig?.persona,
                memoryUserId,
                memoryDefaultScope,
                isScheduledJob: true,
                jobId: currentJob.id,
                jobName: currentJob.name,
                runId,
                jobModelUseKind,
                assistantName: ASSISTANT_NAME,
                memoryContextBlock: turnContext?.memoryContextBlock,
                allowedTools: toolPolicy.effectiveAllowedTools,
                toolAccessRequirements:
                  toolAccessRequirementPreflight.toolAccessRequirements,
                selectedSkillIds,
                selectedMcpServerIds,
              },
              (proc, runHandle) => {
                void updateRunProviderMetadata({ providerRunId: runHandle });
                deps.onProcess(
                  queueJid,
                  proc,
                  runHandle,
                  execution.group.folder,
                  execution.stopAliasJids,
                );
              },
              async (streamedOutput: AgentOutput) => {
                await forwardRunnerRuntimeEvents({
                  events: streamedOutput.runtimeEvents,
                  diagnostics,
                  emitJobEvent,
                });
                if (streamedOutput.usage) latestUsage = streamedOutput.usage;
                if (streamedOutput.newSessionId) {
                  await updateRunProviderMetadata({
                    providerSessionId: streamedOutput.newSessionId,
                  });
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
                  diagnostics.latestStreamedOutputChars = chunkChars;
                  diagnostics.totalStreamedOutputChars += chunkChars;
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
            await updateRunProviderMetadata({ force: true });
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
              error = formatTerminalToolDenial(diagnostics) ?? null;
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
          }
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
          await updateRunProviderMetadata({ force: true });
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
    deletedDuringRun = deletionGuard.deletedDuringRun;
    if (deletionGuard.deletedDuringRun) {
      result = null;
      error = null;
    }
    const {
      runStatus,
      nextRun,
      retryCount,
      pauseReason,
      safeErrorSummary,
      toolDenial,
    } = await finalizeSchedulerJobRun({
      currentJob,
      deps,
      scheduledFor,
      now,
      error,
      diagnostics,
      pausedForSetupDuringRun,
      deletedDuringRun: deletionGuard.deletedDuringRun,
      runtimeAppId,
      appSession: eventState.eventAppSession ?? preflightAppSession,
      publishRuntimeEvent: async (event) => {
        await getRuntimeEventExchange().publish(event);
      },
    });
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
    terminalRunRecorded = true;
    await emitJobEvent(runtimeEventTypeForRunStatus(runStatus), {
      next_run: nextRun,
      retry_count: retryCount,
      pause_reason: pauseReason,
      diagnostics: terminalDiagnosticsPayload(diagnostics),
    });
    await closeBrowserAfterJobRun({
      currentJob,
      executionGroupFolder: execution?.group.folder,
      executionJid: execution?.executionJid,
      diagnostics,
      deps,
      emitJobEvent,
      logger,
    });
    if (toolDenial)
      await emitJobEvent(RUNTIME_EVENT_TYPES.JOB_TOOL_DENIED, {
        error_summary: safeErrorSummary ? safeErrorSummary.slice(0, 500) : null,
        denied_tool: toolDenial.toolName,
        recovery_action: toolDenial.recoveryAction ?? null,
        recovery_kind: toolDenial.recoveryAction?.startsWith(
          'request_permission',
        )
          ? 'persistent_capability'
          : 'job_policy',
      });
    const summary = safeErrorSummary
      ? safeErrorSummary.slice(0, 1_200)
      : safeResultSummary
        ? safeResultSummary.slice(0, 4_000)
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
        diagnostics: terminalDiagnosticsPayload(diagnostics),
      },
    );
    await publishSchedulerCompletionEvent({
      currentJob,
      runId,
      runStatus,
      notified,
      startNotified,
      summary,
      nextRun,
      state: eventState,
      runtimeAppId,
      control: eventControl,
      publishRuntimeEvent: async (event) => {
        await getRuntimeEventExchange().publish(event);
      },
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
  } finally {
    if (!terminalRunRecorded && !deletedDuringRun) {
      await completeFailedRunFailsafe({
        opsRepository: deps.opsRepository,
        jobId: currentJob.id,
        runId,
        logger,
      });
    }
  }
}
