import fs from 'fs';
// prettier-ignore
import { ASSISTANT_NAME, getEffectiveModelConfig, getRuntimeSettingsForConfig, getSelectedAgentHarness } from '../config/index.js';
import type { Job } from '../domain/types.js';
import { logger, updateLogContext } from '../infrastructure/logging/logger.js';
// prettier-ignore
import { getRuntimeControlRepository, getRuntimeEventExchange, getConfiguredModelProvidersForApp, getWorkerCoordinationRepository } from '../adapters/storage/postgres/runtime-store.js';
import { DEFAULT_JOB_RUNTIME_APP_ID } from '../application/jobs/job-access.js';
import { splitAccessRequirements } from '../application/jobs/job-access-requirements.js';
import * as jobToolPolicy from '../application/jobs/job-tool-policy.js';
import { SETUP_REQUIRED_PAUSE_REASON } from '../application/jobs/job-readiness-service.js';
import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import { nowIso, nowMs, toIso } from '../shared/time/datetime.js';
import { accumulateModelUsage } from '../shared/model-usage.js';
import { resolveWorkspaceFolderPath } from '../platform/workspace-folder.js';
import { AgentOutput, spawnAgent } from '../runtime/agent-spawn.js';
import { resolveModelFamilyCandidatesForApp } from '../runtime/model-family-resolution.js';
import { runJobAgentWithFailover } from './execution-failover.js';
import { publishRunFailoverEvent } from '../runtime/failover-candidate-loop.js';
import { providerSessionExternalSessionId } from '../runtime/agent-output-provider-session.js';
import {
  buildRuntimeRunOptions,
  completeSuccessfulRuntimeSessionRun,
  createRuntimeUserVisibleResultAccumulator,
  failRuntimeSessionRun as failSessionRun,
} from '../runtime/session-resume-runtime.js';
import {
  resolveTurnSemanticCapabilities,
  resolveTurnSelectedMcpServerIds,
  resolveTurnSelectedSkillContext,
} from '../runtime/group-run-context.js';
// prettier-ignore
import { collectCompactBoundaryMemory, collectJobCompletionMemory } from './compact-memory.js';
import { normalizeCleanupAfterMs } from './cleanup.js';
import {
  buildExecutionTurnContextInput,
  resolveExecutionContext,
  resolveExecutionMemoryContext,
} from './execution-context.js';
import {
  logMemoryDreamJobFailure,
  notifySchedulerTerminalRunState,
} from './execution-notifications.js';
import {
  claimSchedulerRunLease,
  createSchedulerRunLeaseAbort,
  startSchedulerRunLeaseHeartbeat,
} from './execution-lease.js';
import { resolveExecutionContextOrDeadLetter } from './execution-dead-letter.js';
import { runSystemJobTurn } from './execution-system-job.js';
import { createJobExecutionDeletionGuard } from './execution-deletion-guard.js';
import { runtimeEventTypeForRunStatus } from './run-status-event.js';
import {
  jobCompletedModelPayload,
  jobStartedModelPayload,
  modelUseKindForJobSchedule,
  resolveJobExecutionProviderId,
  resolveJobModel,
} from './model-resolution.js';
// prettier-ignore
import { createJobRunDiagnostics, createStreamingEventFlusher, filterUnforwardedRunnerRuntimeEvents, formatTerminalToolDenial, forwardRunnerRuntimeEvents, runnerRuntimeEventKey, terminalDiagnosticsPayload, toolDenialEventPayload } from './execution-diagnostics.js';
import { pauseJobForSetupIfNeeded } from './execution-readiness.js';
import {
  bindSchedulerRunEventState,
  createRuntimeEventPublisher as createEventPublisher,
  createSchedulerJobEventEmitter,
  publishSchedulerCompletionEvent,
} from './execution-runtime-events.js';
import { resolveAppSessionForJob } from './app-session-resolution.js';
import { finalizeSchedulerJobRun } from './execution-finalization.js';
import { assertToolAccessRequirementsReadyForRun } from './execution-tool-access-requirements.js';
import { closeBrowserAfterJobRun } from './execution-browser-cleanup.js';
import { prelaunchBrowserForJobRun } from './execution-browser-prelaunch.js';
import { isTrustedSystemJob } from '../shared/system-job-identity.js';
import { completeFailedRunFailsafe } from './run-failsafe.js';
import { createRunProviderMetadataUpdater } from './run-provider-metadata.js';
import { hasAsyncTaskRepository } from './async-command-task-helpers.js';
import { runActiveJobWithLogContext } from './execution-log-context.js';
import {
  recordJobAgentRunFailure,
  requireTerminalSettlement,
} from './execution-operational-errors.js';
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
  control?: { abortSignal?: AbortSignal },
): Promise<void> {
  return runActiveJobWithLogContext({
    requestedJob: job,
    dispatch,
    getJobById: (jobId) => deps.opsRepository.getJobById(jobId),
    run: ({ job: currentJob, scheduledFor, runId }) =>
      runActiveJob(
        currentJob,
        deps,
        queueJid,
        dispatch,
        control,
        scheduledFor,
        runId,
      ),
  });
}

async function runActiveJob(
  currentJob: Job,
  deps: SchedulerDependencies,
  queueJid: string,
  dispatch: SchedulerDispatchPayload | undefined,
  control: { abortSignal?: AbortSignal } | undefined,
  scheduledFor: string,
  runId: string,
): Promise<void> {
  const startedAtMs = nowMs();
  const startedAt = toIso(startedAtMs);
  const runtimeAppId = DEFAULT_JOB_RUNTIME_APP_ID;
  const publishRuntimeEvent = createEventPublisher(getRuntimeEventExchange());
  const warn = (context: Record<string, unknown>, message: string): void =>
    logger.warn(context, message);
  const groups = deps.conversationRoutes();
  const execution = await resolveExecutionContextOrDeadLetter({
    resolve: () => resolveExecutionContext(currentJob, groups),
    currentJob,
    deps,
    runId,
    scheduledFor,
    startedAt,
    startedAtMs,
    dispatch,
    runtimeAppId,
    control: getRuntimeControlRepository(),
    publishRuntimeEvent,
    logger,
  });
  if (!execution) return;
  const timeoutMs = Math.max(30_000, currentJob.timeout_ms || 300_000);
  const leaseExpiresAt = toIso(nowMs() + timeoutMs + 30_000);
  const jobModelUseKind = modelUseKindForJobSchedule(currentJob.schedule_type);
  const jobFailoverCandidates = await resolveModelFamilyCandidatesForApp({
    alias: currentJob.model || '',
    appId: runtimeAppId,
    listConfiguredProviders: getConfiguredModelProvidersForApp,
    familyOrder: getRuntimeSettingsForConfig().modelFamilies,
  });
  const jobModelForResolution = jobFailoverCandidates[0] ?? '';
  const agentHarness = getSelectedAgentHarness(execution.group.folder);
  const resolvedModel = resolveJobModel(
    { ...currentJob, model: jobModelForResolution || currentJob.model },
    getEffectiveModelConfig(undefined, jobModelUseKind, execution.group.folder),
    agentHarness,
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
    source: 'preflight_setup',
    runId,
    publishRuntimeEvent,
  });
  if (pausedForSetup) return;
  let executionProviderId = resolveJobExecutionProviderId({
    resolvedModel,
    executionAdapter: deps.executionAdapter,
    executionAdapters: deps.executionAdapters,
    fallbackForInjectedRunner: Boolean(deps.runAgent),
  });
  const leaseContext = await claimSchedulerRunLease({
    deps,
    currentJob,
    runId,
    executionProviderId,
    workerId: execution.group.folder,
    leaseOwner: execution.executionJid,
    scheduledFor,
    startedAt,
    leaseExpiresAt,
    requireNextRun:
      currentJob.schedule_type !== 'manual' && !dispatch?.triggerId,
    getCoordinationRepository: getWorkerCoordinationRepository,
    warn,
  });
  if (!leaseContext) return;
  const runLeaseAbort = createSchedulerRunLeaseAbort();
  const leaseHeartbeat = startSchedulerRunLeaseHeartbeat({
    runId,
    leaseContext,
    ttlMs: timeoutMs + 30_000,
    deadlineMs: startedAtMs + timeoutMs,
    getCoordinationRepository: getWorkerCoordinationRepository,
    warn,
    onLeaseLost: runLeaseAbort.abort,
    externalAbortSignal: control?.abortSignal,
  });
  let terminalRunRecorded = false,
    deletedDuringRun = false;
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
      publishRuntimeEvent,
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
      publishRuntimeEvent,
      deletionGuard,
      logger,
    });
    await emitJobEvent(RUNTIME_EVENT_TYPES.JOB_STARTED, {
      queue_jid: queueJid,
      scheduled_for: scheduledFor,
      timeout_ms: timeoutMs,
      sandbox_provider: deps.runnerSandboxProvider?.id ?? 'direct',
      sandbox_enforcing: deps.runnerSandboxProvider?.enforcing === true,
      ...jobStartedModelPayload(resolvedModel),
    });
    let result: string | null = null;
    let error: string | null =
      resolvedModel.routeResolution && !resolvedModel.routeResolution.ok
        ? resolvedModel.routeResolution.message
        : null;
    const diagnostics = createJobRunDiagnostics();
    let pausedForSetupDuringRun = false;
    let setupStateForSetupPause: NonNullable<Job['setup_state']> | undefined;
    const resultSummaryAccumulator =
      createRuntimeUserVisibleResultAccumulator();
    let hasStreamedResult = false;
    let agentRunId: string | undefined;
    const streamedRuntimeEventKeys = new Set<string>();
    const appendResultSummary = (delta: string | null | undefined): void => {
      if (!delta) return;
      resultSummaryAccumulator.append(delta);
    };
    let accumulatedUsage: AgentOutput['usage'];
    const startNotified = false;
    try {
      const groupDir = resolveWorkspaceFolderPath(execution.group.folder);
      fs.mkdirSync(groupDir, { recursive: true });
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const { memoryDefaultScope, memoryUserId } = resolveExecutionMemoryContext({
      conversationKind: execution.group.conversationKind,
      executionJid: execution.executionJid,
    });
    if (!error && isTrustedSystemJob(currentJob)) {
      const systemOutcome = await runSystemJobTurn({
        currentJob,
        startedAtMs,
        timeoutMs,
        signal: runLeaseAbort.signal,
        logger,
        context: {
          folder: execution.group.folder,
          conversationId: execution.executionJid,
          conversationKind: execution.group.conversationKind,
          userId: memoryUserId,
          threadId: execution.threadId,
        },
      });
      appendResultSummary(systemOutcome.result);
      error = systemOutcome.error;
    } else {
      if (!error) {
        let turnContext: JobTurnContext | undefined;
        const failRun = () =>
          failSessionRun(deps.opsRepository, agentRunId, error);
        const updateRunProviderMetadata = createRunProviderMetadataUpdater({
          opsRepository: deps.opsRepository,
          jobId: currentJob.id,
          outerRunId: runId,
          leaseToken: leaseContext.lease.leaseToken,
          workerInstanceId: leaseContext.lease.workerInstanceId,
          fencingVersion: leaseContext.lease.fencingVersion,
          getSessionRunId: () => agentRunId,
          nowMs,
          logger,
        });
        const streamingFlusher = createStreamingEventFlusher({
          nowMs,
          emit: (payload) =>
            emitJobEvent(RUNTIME_EVENT_TYPES.JOB_STREAMING, payload),
        });
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
            jobToolPolicy.agentIdForJobWorkspaceKey(execution.group.folder);
          updateLogContext({
            appId: executionAppId,
            agentId: executionAgentId,
          });
          const [
            toolPolicy,
            selectedSkillContext,
            semanticCapabilities,
            credentialBroker,
          ] = await Promise.all([
            jobToolPolicy.resolveJobToolPolicy({
              job: currentJob,
              appId: executionAppId,
              agentId: executionAgentId,
              toolRepository: deps.getToolRepository?.(),
              skillRepository: deps.getSkillRepository?.(),
            }),
            resolveTurnSelectedSkillContext(deps, {
              appId: executionAppId,
              agentId: executionAgentId,
            }),
            resolveTurnSemanticCapabilities(deps, {
              appId: executionAppId,
              agentId: executionAgentId,
            }),
            deps.getCredentialBroker?.() ?? Promise.resolve(undefined),
          ]);
          const attachedMcpSourceIds = await resolveTurnSelectedMcpServerIds(
            deps,
            {
              appId: executionAppId,
              agentId: executionAgentId,
            },
            toolPolicy.effectiveAllowedTools,
          );
          const toolAccessRequirementPreflight =
            await assertToolAccessRequirementsReadyForRun({
              toolAccessRequirements: splitAccessRequirements(
                currentJob.access_requirements,
              ).toolAccessRequirements,
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
            source: 'final_setup',
            runId,
            publishRuntimeEvent,
          }));
          const browserPrelaunchSetup = finalReadinessPassed
            ? await prelaunchBrowserForJobRun({
                currentJob,
                executionGroupFolder: execution.group.folder,
                executionJid: execution.executionJid,
                diagnostics,
                deps,
                emitJobEvent,
                logger,
              })
            : undefined;
          if (!finalReadinessPassed) {
            pausedForSetupDuringRun = true;
            error = SETUP_REQUIRED_PAUSE_REASON;
          } else if (browserPrelaunchSetup) {
            error = browserPrelaunchSetup.error;
            setupStateForSetupPause = browserPrelaunchSetup.setupState;
            pausedForSetupDuringRun = true;
          }
          if (!error) {
            const runOptions = buildRuntimeRunOptions({
              timeoutMs,
              signal: runLeaseAbort.signal,
              credentialBroker,
              skillRepository: deps.getSkillRepository?.(),
              skillArtifactStore: deps.getSkillArtifactStore?.(),
              mcpServerRepository: deps.getMcpServerRepository?.(),
              capabilitySecretRepository:
                deps.getCapabilitySecretRepository?.(),
              mcpHostnameLookup: deps.getMcpHostnameLookup?.(),
              mcpDnsValidationCache: deps.getMcpDnsValidationCache?.(),
              publishRuntimeEvent,
              executionAdapter: deps.executionAdapter,
              executionAdapters: deps.executionAdapters,
              runnerSandboxProvider: deps.runnerSandboxProvider,
              asyncTaskRepositoryAvailable: hasAsyncTaskRepository(deps),
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
            const output = await runJobAgentWithFailover({
              group: execution.group,
              candidates: jobFailoverCandidates,
              firstModel: resolvedModel.selectedModel,
              spawn: deps.runAgent ?? spawnAgent,
              runOptions,
              fallbackProviderId: executionProviderId,
              agentHarness,
              hasStreamedOutput: () => hasStreamedResult,
              onFailover: async (toProviderId, details) => {
                const fromProviderId = executionProviderId;
                executionProviderId = toProviderId;
                error = null;
                await updateRunProviderMetadata({
                  providerRunId: null,
                  providerSessionId: null,
                });
                publishRunFailoverEvent({
                  publish: publishRuntimeEvent,
                  appId: executionAppId,
                  agentId: executionAgentId,
                  runId,
                  conversationId: execution.executionJid,
                  threadId: execution.threadId || undefined,
                  fromProvider: fromProviderId,
                  family: execution.group.agentConfig?.model ?? null,
                  details,
                });
                return fromProviderId;
              },
              log: (message) =>
                logger.warn({ jobId: currentJob.id, runId }, message),
              baseInput: {
                prompt: currentJob.prompt,
                workspaceFolder: execution.group.folder,
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
                runLeaseToken: leaseContext.lease.leaseToken,
                runLeaseFencingVersion: leaseContext.lease.fencingVersion,
                jobModelUseKind,
                assistantName: ASSISTANT_NAME,
                memoryContextBlock: turnContext?.memoryContextBlock,
                toolPolicyRules: toolPolicy.effectiveAllowedTools,
                toolAccessRequirements:
                  toolAccessRequirementPreflight.toolAccessRequirements,
                runtimeAccess: toolPolicy.runtimeAccess,
                attachedSkillSourceIds: selectedSkillContext.ids,
                selectedSkillDisplays: selectedSkillContext.displays,
                attachedMcpSourceIds,
                semanticCapabilities,
              },
              onProcess: (proc, runHandle) => {
                void updateRunProviderMetadata({ providerRunId: runHandle });
                deps.onProcess(
                  queueJid,
                  proc,
                  runHandle,
                  execution.group.folder,
                  execution.stopAliasJids,
                );
              },
              streamHandler: async (streamedOutput: AgentOutput) => {
                if (runLeaseAbort.isAborted()) return;
                for (const event of streamedOutput.runtimeEvents ?? []) {
                  const eventKey = runnerRuntimeEventKey(event);
                  if (eventKey) streamedRuntimeEventKeys.add(eventKey);
                }
                await forwardRunnerRuntimeEvents({
                  events: streamedOutput.runtimeEvents,
                  diagnostics,
                  emitJobEvent,
                });
                if (streamedOutput.usage)
                  accumulatedUsage = accumulateModelUsage(
                    accumulatedUsage,
                    streamedOutput.usage,
                  );
                const streamedProviderSessionId =
                  providerSessionExternalSessionId(streamedOutput);
                if (streamedProviderSessionId) {
                  await updateRunProviderMetadata({
                    providerSessionId: streamedProviderSessionId,
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
                  streamingFlusher.append(chunkChars);
                  streamingFlusher.flush();
                }
                if (streamedOutput.status === 'error') {
                  error = streamedOutput.error || 'Unknown error';
                }
              },
            });
            if (runLeaseAbort.isAborted()) {
              error = runLeaseAbort.error;
            } else {
              streamingFlusher.flush(true);
              await forwardRunnerRuntimeEvents({
                events: filterUnforwardedRunnerRuntimeEvents(
                  output.runtimeEvents,
                  streamedRuntimeEventKeys,
                ),
                diagnostics,
                emitJobEvent,
              });
              await updateRunProviderMetadata({ force: true });
              if (output.status === 'error') {
                recordJobAgentRunFailure();
                if (!error) error = output.error || 'Unknown error';
                await failRun();
              } else if (output.result && !hasStreamedResult) {
                appendResultSummary(output.result);
              }
              if (!error) error = formatTerminalToolDenial(diagnostics) ?? null;
              if (!error) {
                const boundedResultSummary =
                  resultSummaryAccumulator.snapshot();
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
                await failRun();
              }
            }
          }
        } catch (err) {
          recordJobAgentRunFailure();
          error = runLeaseAbort.errorFor(err);
          if (!runLeaseAbort.isAborted()) {
            await updateRunProviderMetadata({ force: true });
            await failRun();
          }
        }
      }
    }
    const now = nowIso();
    await deletionGuard.isJobDeleted(true);
    deletedDuringRun = deletionGuard.deletedDuringRun;
    if (deletionGuard.deletedDuringRun) result = error = null;
    const safeResultSummary = deletionGuard.deletedDuringRun
      ? null
      : result || resultSummaryAccumulator.snapshot() || null;
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
      setupStateForSetupPause,
      deletedDuringRun: deletionGuard.deletedDuringRun,
      runtimeAppId,
      runId,
      appSession: eventState.eventAppSession ?? preflightAppSession,
      publishRuntimeEvent,
      updateJobState: async (jobUpdates, state) => {
        if (deletionGuard.deletedDuringRun) return;
        const finalizeWithLease = deps.opsRepository.finalizeJobRunWithLease;
        await requireTerminalSettlement(
          finalizeWithLease?.call(deps.opsRepository, {
            jobId: currentJob.id,
            runId,
            leaseToken: leaseContext.lease.leaseToken,
            workerInstanceId: leaseContext.lease.workerInstanceId,
            fencingVersion: leaseContext.lease.fencingVersion,
            leaseOutcome: error ? 'failed' : 'completed',
            runStatus: state.runStatus,
            resultSummary: safeResultSummary
              ? safeResultSummary.slice(0, 500)
              : null,
            errorSummary: state.safeErrorSummary
              ? state.safeErrorSummary.slice(0, 500)
              : null,
            jobUpdates,
          }),
          'Scheduler run lease finalization is unavailable for terminal job write.',
          'Scheduler run lease is no longer active during terminal finalization.',
        );
        terminalRunRecorded = true;
      },
    });
    if (!terminalRunRecorded && !deletionGuard.deletedDuringRun) {
      const finalizeRunLease = deps.opsRepository.finalizeJobRunLease;
      await requireTerminalSettlement(
        finalizeRunLease?.call(deps.opsRepository, {
          runId,
          leaseToken: leaseContext.lease.leaseToken,
          workerInstanceId: leaseContext.lease.workerInstanceId,
          fencingVersion: leaseContext.lease.fencingVersion,
          leaseOutcome: error ? 'failed' : 'completed',
          runStatus,
          resultSummary: safeResultSummary
            ? safeResultSummary.slice(0, 500)
            : null,
          errorSummary: safeErrorSummary
            ? safeErrorSummary.slice(0, 500)
            : null,
        }),
        'Scheduler run lease finalization is unavailable for terminal run write.',
        'Scheduler run lease is no longer active during terminal finalization.',
      );
      terminalRunRecorded = true;
    }
    if (runLeaseAbort.isAborted())
      await failSessionRun(deps.opsRepository, agentRunId, error);
    if (!deletionGuard.deletedDuringRun) {
      await leaseContext.recordRunnerControlEvent('terminal_state', {
        outcome: error ? 'failed' : 'completed',
        fencingVersion: leaseContext.lease.fencingVersion,
      });
    }
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
      snapshotRunId: runId,
      snapshotFencingVersion: leaseContext.lease.fencingVersion,
      emitJobEvent,
      logger,
    });
    if (toolDenial)
      await emitJobEvent(
        RUNTIME_EVENT_TYPES.JOB_TOOL_DENIED,
        toolDenialEventPayload(toolDenial, safeErrorSummary),
      );
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
      const markJobRunNotified = deps.opsRepository.markJobRunNotified;
      await requireTerminalSettlement(
        markJobRunNotified?.call(deps.opsRepository, runId, {
          leaseToken: leaseContext.lease.leaseToken,
          workerInstanceId: leaseContext.lease.workerInstanceId,
          fencingVersion: leaseContext.lease.fencingVersion,
        }),
        'Scheduler run lease notification finalization is unavailable.',
        'Scheduler run lease is no longer valid during notification finalization.',
      );
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
        ...jobCompletedModelPayload(resolvedModel, accumulatedUsage),
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
      publishRuntimeEvent,
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
    leaseHeartbeat.stop();
    if (!terminalRunRecorded && !deletedDuringRun) {
      await completeFailedRunFailsafe({
        opsRepository: deps.opsRepository,
        jobId: currentJob.id,
        runId,
        leaseToken: leaseContext.lease.leaseToken,
        workerInstanceId: leaseContext.lease.workerInstanceId,
        fencingVersion: leaseContext.lease.fencingVersion,
        recordRunnerControlEvent: leaseContext.recordRunnerControlEvent,
        logger,
      });
    }
  }
}
