import fs from 'fs';
import { splitAccessRequirements } from '../application/jobs/job-access-requirements.js';
import { evaluateToolAccessRequirements } from '../application/jobs/job-tool-access-requirements.js';
import * as jobToolPolicy from '../application/jobs/job-tool-policy.js';
import { SETUP_REQUIRED_PAUSE_REASON } from '../application/jobs/job-readiness-service.js';
import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import type { ExecutionProviderId } from '../domain/sessions/sessions.js';
import { logger, updateLogContext } from '../infrastructure/logging/logger.js';
import type { AgentOutput } from '../runtime/agent-spawn.js';
import { providerSessionExternalSessionId } from '../runtime/agent-output-provider-session.js';
import {
  publishRunFailoverEvent,
  type FailoverAdvanceDetails,
} from '../runtime/failover-candidate-loop.js';
// prettier-ignore
import { loadAgentAccessSnapshot, resolveTurnSemanticCapabilitiesFromSnapshot, resolveTurnSelectedMcpServerIdsFromSnapshot, resolveTurnSelectedSkillContextFromSnapshot, resolveTurnToolPolicyFromSnapshot } from '../runtime/group-run-context.js';
// prettier-ignore
import { buildRuntimeRunOptions, completeSuccessfulRuntimeSessionRun, createRuntimeUserVisibleResultAccumulator, failRuntimeSessionRun as failSessionRun } from '../runtime/session-resume-runtime.js';
import { accumulateModelUsage } from '../shared/model-usage.js';
import { nowIso, nowMs } from '../shared/time/datetime.js';
import { resolveWorkspaceFolderPath } from '../platform/workspace-folder.js';
import { isTrustedSystemJob } from '../shared/system-job-identity.js';
import { hasAsyncTaskRepository } from './async-command-task-helpers.js';
import { resolveAppSessionForJob } from './app-session-resolution.js';
import { normalizeCleanupAfterMs } from './cleanup.js';
// prettier-ignore
import { collectCompactBoundaryMemory, collectJobCompletionMemory } from './compact-memory.js';
import { createJobExecutionDeletionGuard } from './execution-deletion-guard.js';
// prettier-ignore
import { createJobRunDiagnostics, createStreamingEventFlusher, filterUnforwardedRunnerRuntimeEvents, formatTerminalToolDenial, forwardRunnerRuntimeEvents, runnerRuntimeEventKey, terminalDiagnosticsPayload } from './execution-diagnostics.js';
import {
  buildExecutionTurnContextInput,
  resolveExecutionMemoryContext,
} from './execution-context.js';
import { runJobAgentWithFailover } from './execution-failover.js';
import { finalizeSchedulerJobRun } from './execution-finalization.js';
import { closeBrowserAfterJobRun } from './execution-browser-cleanup.js';
// prettier-ignore
import { logMemoryDreamJobFailure, notifySchedulerTerminalRunState, schedulerTerminalRunSummary as terminalSummary } from './execution-notifications.js';
import {
  recordJobAgentRunFailure,
  requireTerminalSettlement,
} from './execution-operational-errors.js';
import { pauseJobForSetupIfNeeded } from './execution-readiness.js';
// prettier-ignore
import { bindSchedulerRunEventState, createSchedulerJobEventEmitter, listRecordedJobRunActions, publishSchedulerCompletionEvent, publishTerminalToolDenials } from './execution-runtime-events.js';
import { runSystemJobTurn } from './execution-system-job.js';
import { scheduledJobRunPrompt } from './job-run-prompt.js';
import {
  jobCompletedModelPayload,
  jobStartedModelPayload,
} from './model-resolution.js';
import { runtimeEventTypeForRunStatus } from './run-status-event.js';
import { createRunProviderMetadataUpdater } from './run-provider-metadata.js';
import type { ActiveJobRunContext } from './execution-phases-setup.js';

export async function bindActiveJobRun(
  context: ActiveJobRunContext,
): Promise<void> {
  const { currentJob, deps, runId, scheduledFor, runtimeAppId } = context;
  const execution = context.execution!;
  // prettier-ignore
  void deps.captureLifecycleNotification?.({ job: currentJob, runId })?.catch(() => deps.discardLifecycleNotification?.(runId));
  const claimedRun = await deps.opsRepository.getJobRunById(runId);
  context.runShortId = claimedRun?.short_id ?? null;
  // prettier-ignore
  context.eventState = await bindSchedulerRunEventState({ currentJob, dispatch: context.dispatch, runId, runShortId: context.runShortId, scheduledFor, runtimeAppId, control: context.eventControl!, publishRuntimeEvent: context.publishRuntimeEvent, logger });
  // prettier-ignore
  context.deletionGuard = createJobExecutionDeletionGuard({ jobId: currentJob.id, runId, nowMs, getJobById: (jobId) => deps.opsRepository.getJobById(jobId), log: logger });
  // prettier-ignore
  context.emitJobEvent = createSchedulerJobEventEmitter({ currentJob, runId, runtimeAppId, state: context.eventState, resolveEventAppSession: () => resolveAppSessionForJob(currentJob, context.eventControl!), publishRuntimeEvent: context.publishRuntimeEvent, deletionGuard: context.deletionGuard, logger });
  // prettier-ignore
  await context.emitJobEvent(RUNTIME_EVENT_TYPES.JOB_STARTED, { queue_jid: context.queueJid, scheduled_for: scheduledFor, timeout_ms: context.timeoutMs, sandbox_provider: deps.runnerSandboxProvider?.id ?? 'direct', sandbox_enforcing: deps.runnerSandboxProvider?.enforcing === true, ...jobStartedModelPayload(context.resolvedModel!) });
  context.result = null;
  context.error =
    context.resolvedModel!.routeResolution &&
    !context.resolvedModel!.routeResolution.ok
      ? context.resolvedModel!.routeResolution.message
      : null;
  context.diagnostics = createJobRunDiagnostics();
  context.pausedForSetupDuringRun = false;
  context.setupStateForSetupPause = undefined;
  context.resultSummaryAccumulator =
    createRuntimeUserVisibleResultAccumulator();
  context.hasStreamedResult = false;
  context.agentRunId = undefined;
  context.streamedRuntimeEventKeys = new Set<string>();
  context.appendResultSummary = (delta): void => {
    if (!delta) return;
    context.resultSummaryAccumulator!.append(delta);
  };
  context.accumulatedUsage = undefined;
  context.memoryReviewNotification = undefined;
  context.startNotified = false;
  try {
    const groupDir = resolveWorkspaceFolderPath(execution.group.folder);
    fs.mkdirSync(groupDir, { recursive: true });
  } catch (err) {
    context.error = err instanceof Error ? err.message : String(err);
  }
  // prettier-ignore
  const { memoryDefaultScope, memoryUserId } = resolveExecutionMemoryContext({ conversationKind: execution.group.conversationKind, executionJid: execution.executionJid });
  context.memoryDefaultScope = memoryDefaultScope;
  context.memoryUserId = memoryUserId;
}

export async function runActiveJobSystemTurn(
  context: ActiveJobRunContext,
): Promise<boolean> {
  if (context.error || !isTrustedSystemJob(context.currentJob)) return false;
  const execution = context.execution!;
  // prettier-ignore
  const systemOutcome = await runSystemJobTurn({ currentJob: context.currentJob, startedAtMs: context.startedAtMs, timeoutMs: context.timeoutMs!, signal: context.runLeaseAbort!.signal, logger, context: { folder: execution.group.folder, conversationId: execution.executionJid, conversationKind: execution.group.conversationKind, userId: context.memoryUserId, threadId: execution.threadId } });
  context.appendResultSummary!(systemOutcome.result);
  context.error = systemOutcome.error;
  context.memoryReviewNotification = systemOutcome.notificationContext;
  return true;
}

export async function runActiveJobAgent(
  context: ActiveJobRunContext,
): Promise<void> {
  if (context.error) return;
  context.turnContext = undefined;
  context.failRun = () =>
    failSessionRun(
      context.deps.opsRepository,
      context.agentRunId,
      context.error,
    );
  // prettier-ignore
  context.updateRunProviderMetadata = createRunProviderMetadataUpdater({ opsRepository: context.deps.opsRepository, jobId: context.currentJob.id, outerRunId: context.runId, leaseToken: context.leaseContext!.lease.leaseToken, workerInstanceId: context.leaseContext!.lease.workerInstanceId, fencingVersion: context.leaseContext!.lease.fencingVersion, getSessionRunId: () => context.agentRunId, nowMs, logger });
  // prettier-ignore
  context.streamingFlusher = createStreamingEventFlusher({ nowMs, emit: (payload) => context.emitJobEvent!(RUNTIME_EVENT_TYPES.JOB_STREAMING, payload) });
  try {
    await prepareActiveJobAgent(context);
    if (!context.error) await invokeActiveJobAgent(context);
  } catch (err) {
    recordJobAgentRunFailure();
    context.error = context.runLeaseAbort!.errorFor(err);
    if (!context.runLeaseAbort!.isAborted()) {
      await context.updateRunProviderMetadata({ force: true });
      await context.failRun();
    }
  }
}

async function prepareActiveJobAgent(
  context: ActiveJobRunContext,
): Promise<void> {
  const { currentJob, deps, runtimeAppId, runId } = context;
  const execution = context.execution!;
  context.turnContext = await deps.opsRepository.getAgentTurnContext?.(
    buildExecutionTurnContextInput({
      agentFolder: execution.group.folder,
      executionProviderId: context.executionProviderId!,
      executionJid: execution.executionJid,
      threadId: execution.threadId,
      conversationKind: execution.group.conversationKind,
      memoryUserId: context.memoryUserId,
      jobId: currentJob.id,
      query: currentJob.prompt,
    }),
  );
  if (context.turnContext?.providerSessionId) {
    await context.updateRunProviderMetadata!({
      providerSessionId: context.turnContext.providerSessionId,
    });
  }
  const executionAppId =
    context.turnContext?.appId ??
    context.eventState!.eventAppSession?.appId ??
    runtimeAppId;
  const executionAgentId =
    context.turnContext?.agentId ??
    jobToolPolicy.agentIdForJobWorkspaceKey(execution.group.folder);
  updateLogContext({ appId: executionAppId, agentId: executionAgentId });
  const snapshotOwner = { appId: executionAppId, agentId: executionAgentId };
  const [accessSnapshot, credentialBroker] = await Promise.all([
    loadAgentAccessSnapshot(deps, snapshotOwner),
    deps.getCredentialBroker?.() ?? Promise.resolve(undefined),
  ]);
  const inheritedToolPolicy = resolveTurnToolPolicyFromSnapshot(
    accessSnapshot,
    currentJob.execution_context?.personId,
  );
  const toolPolicy: jobToolPolicy.JobToolPolicyResolution = {
    inheritedTools: inheritedToolPolicy.toolPolicyRules ?? [],
    effectiveAllowedTools: inheritedToolPolicy.toolPolicyRules ?? [],
    runtimeAccess: inheritedToolPolicy.runtimeAccess,
  };
  const selectedSkillContext =
    resolveTurnSelectedSkillContextFromSnapshot(accessSnapshot);
  const semanticCapabilities =
    resolveTurnSemanticCapabilitiesFromSnapshot(accessSnapshot);
  const attachedMcpSourceIds = resolveTurnSelectedMcpServerIdsFromSnapshot(
    accessSnapshot,
    {
      conversationId: execution.group.conversationId,
      threadId: execution.threadId ?? undefined,
    },
  );
  const toolAccessRequirements = evaluateToolAccessRequirements({
    toolAccessRequirements: splitAccessRequirements(
      currentJob.access_requirements,
    ).toolAccessRequirements,
    effectiveAllowedTools: toolPolicy.effectiveAllowedTools,
  }).toolAccessRequirements;
  context.agentPreparation = {
    accessSnapshot,
    credentialBroker,
    executionAppId,
    executionAgentId,
    toolPolicy,
    selectedSkillContext,
    semanticCapabilities,
    attachedMcpSourceIds,
    toolAccessRequirements,
  };
  const finalReadinessPassed = !(await pauseJobForSetupIfNeeded({
    currentJob,
    deps,
    executionAgentFolder: execution.group.folder,
    runtimeAppId,
    appSession:
      context.eventState!.eventAppSession ?? context.preflightAppSession,
    agentId: executionAgentId,
    source: 'final_setup',
    runId,
    accessSnapshot,
    publishRuntimeEvent: context.publishRuntimeEvent,
  }));
  if (!finalReadinessPassed) {
    context.pausedForSetupDuringRun = true;
    context.error = SETUP_REQUIRED_PAUSE_REASON;
  }
}

async function invokeActiveJobAgent(
  context: ActiveJobRunContext,
): Promise<void> {
  const { currentJob, deps, runId } = context;
  const execution = context.execution!;
  const preparation = context.agentPreparation!;
  const runOptions = buildRuntimeRunOptions({
    timeoutMs: context.timeoutMs!,
    signal: context.runLeaseAbort!.signal,
    credentialBroker: preparation.credentialBroker,
    skillRepository: deps.getSkillRepository?.(),
    skillArtifactStore: deps.getSkillArtifactStore?.(),
    mcpServerRepository: deps.getMcpServerRepository?.(),
    capabilitySecretRepository: deps.getCapabilitySecretRepository?.(),
    mcpHostnameLookup: deps.getMcpHostnameLookup?.(),
    mcpDnsValidationCache: deps.getMcpDnsValidationCache?.(),
    publishRuntimeEvent: context.publishRuntimeEvent,
    executionAdapter: deps.executionAdapter,
    executionAdapters: deps.executionAdapters,
    runnerSandboxProvider: deps.runnerSandboxProvider,
    asyncTaskRepositoryAvailable: hasAsyncTaskRepository(deps),
    conversationRoutes: context.groups,
    skillContext: {
      appId: preparation.executionAppId,
      agentId: preparation.executionAgentId,
    },
  });
  if (preparation.accessSnapshot)
    runOptions.accessSnapshot = preparation.accessSnapshot;
  context.agentRunId = context.turnContext?.agentSessionId
    ? await deps.opsRepository.createSessionAgentRun?.({
        agentSessionId: context.turnContext.agentSessionId,
        executionProviderId: context.executionProviderId!,
        providerSessionId: context.turnContext.providerSessionId,
        cause: 'job',
      })
    : undefined;
  const output = await runJobAgentWithFailover({
    group: execution.group,
    candidates: context.jobFailoverCandidates!,
    firstModel: context.resolvedModel!.selectedModel,
    spawn: deps.runAgent,
    runOptions,
    fallbackProviderId: context.executionProviderId!,
    agentHarness: context.agentHarness,
    hasStreamedOutput: () => context.hasStreamedResult!,
    onFailover: (toProviderId, details) =>
      handleActiveJobFailover(context, toProviderId, details),
    log: (message) => logger.warn({ jobId: currentJob.id, runId }, message),
    baseInput: {
      prompt: scheduledJobRunPrompt(currentJob),
      workspaceFolder: execution.group.folder,
      chatJid: execution.executionJid,
      threadId: execution.threadId || undefined,
      appId: preparation.executionAppId,
      agentId: preparation.executionAgentId,
      persona: execution.group.agentConfig?.persona,
      memoryUserId: context.memoryUserId,
      memoryDefaultScope: context.memoryDefaultScope!,
      isScheduledJob: true,
      // scheduler_retry_ask: this one run asks interactively (job unchanged).
      ...(context.eventState?.interactiveAskOverride
        ? { permissionMode: 'ask' as const }
        : {}),
      jobId: currentJob.id,
      jobName: currentJob.name,
      runId,
      runLeaseToken: context.leaseContext!.lease.leaseToken,
      runLeaseFencingVersion: context.leaseContext!.lease.fencingVersion,
      jobModelUseKind: context.jobModelUseKind!,
      assistantName: context.assistantName,
      memoryContextBlock: context.turnContext?.memoryContextBlock,
      toolPolicyRules: preparation.toolPolicy.effectiveAllowedTools,
      toolAccessRequirements: preparation.toolAccessRequirements,
      runtimeAccess: preparation.toolPolicy.runtimeAccess,
      attachedSkillSourceIds: preparation.selectedSkillContext.ids,
      selectedSkillDisplays: preparation.selectedSkillContext.displays,
      attachedMcpSourceIds: preparation.attachedMcpSourceIds,
      semanticCapabilities: preparation.semanticCapabilities,
    },
    onProcess: (proc, runHandle) => {
      void context.updateRunProviderMetadata!({ providerRunId: runHandle });
      deps.onProcess(
        context.queueJid,
        proc,
        runHandle,
        execution.group.folder,
        execution.stopAliasJids,
      );
    },
    streamHandler: (streamedOutput) =>
      handleActiveJobStreamOutput(context, streamedOutput),
  });
  await settleActiveJobAgentOutput(context, output);
}

async function handleActiveJobFailover(
  context: ActiveJobRunContext,
  toProviderId: ExecutionProviderId,
  details: FailoverAdvanceDetails,
): Promise<ExecutionProviderId> {
  const execution = context.execution!;
  const preparation = context.agentPreparation!;
  const fromProviderId = context.executionProviderId!;
  context.executionProviderId = toProviderId;
  context.error = null;
  await context.updateRunProviderMetadata!({
    providerRunId: null,
    providerSessionId: null,
  });
  publishRunFailoverEvent({
    publish: context.publishRuntimeEvent,
    appId: preparation.executionAppId,
    agentId: preparation.executionAgentId,
    runId: context.runId,
    conversationId: execution.executionJid,
    threadId: execution.threadId || undefined,
    fromProvider: fromProviderId,
    family: execution.group.agentConfig?.model ?? null,
    details,
  });
  return fromProviderId;
}

async function handleActiveJobStreamOutput(
  context: ActiveJobRunContext,
  streamedOutput: AgentOutput,
): Promise<void> {
  if (context.runLeaseAbort!.isAborted()) return;
  const unforwardedRuntimeEvents = filterUnforwardedRunnerRuntimeEvents(
    streamedOutput.runtimeEvents,
    context.streamedRuntimeEventKeys!,
  );
  for (const event of unforwardedRuntimeEvents ?? []) {
    const eventKey = runnerRuntimeEventKey(event);
    if (eventKey) context.streamedRuntimeEventKeys!.add(eventKey);
  }
  await forwardRunnerRuntimeEvents({
    events: unforwardedRuntimeEvents,
    diagnostics: context.diagnostics!,
    emitJobEvent: context.emitJobEvent!,
  });
  if (streamedOutput.usage)
    context.accumulatedUsage = accumulateModelUsage(
      context.accumulatedUsage,
      streamedOutput.usage,
    );
  const streamedProviderSessionId =
    providerSessionExternalSessionId(streamedOutput);
  if (streamedProviderSessionId) {
    await context.updateRunProviderMetadata!({
      providerSessionId: streamedProviderSessionId,
    });
  }
  await collectCompactBoundaryMemory({
    compactBoundary: streamedOutput.compactBoundary,
    agentSessionId: context.turnContext?.agentSessionId,
    collectMemory: context.deps.collectSessionMemory,
    defaultScope: context.memoryDefaultScope!,
    logger,
    context: { jobId: context.currentJob.id, runId: context.runId },
  });
  if (streamedOutput.result) {
    context.hasStreamedResult = true;
    context.appendResultSummary!(streamedOutput.result);
    const chunkChars = streamedOutput.result.length;
    context.diagnostics!.latestStreamedOutputChars = chunkChars;
    context.diagnostics!.totalStreamedOutputChars += chunkChars;
    context.streamingFlusher!.append(chunkChars);
    context.streamingFlusher!.flush();
  }
  if (streamedOutput.status === 'error') {
    context.error = streamedOutput.error || 'Unknown error';
  }
}

async function settleActiveJobAgentOutput(
  context: ActiveJobRunContext,
  output: AgentOutput,
): Promise<void> {
  const { currentJob, deps, runId } = context;
  const execution = context.execution!;
  if (context.runLeaseAbort!.isAborted()) {
    context.error = context.runLeaseAbort!.error;
  } else {
    context.streamingFlusher!.flush(true);
    await forwardRunnerRuntimeEvents({
      events: filterUnforwardedRunnerRuntimeEvents(
        output.runtimeEvents,
        context.streamedRuntimeEventKeys!,
      ),
      diagnostics: context.diagnostics!,
      emitJobEvent: context.emitJobEvent!,
    });
    const browserActivityEvents = await context.runtimeEventExchange.list({
      appId: (context.eventState!.eventAppSession?.appId ??
        context.runtimeAppId) as never,
      jobId: currentJob.id as never,
      runId: runId as never,
      eventTypes: [RUNTIME_EVENT_TYPES.TOOL_ACTIVITY],
    });
    await forwardRunnerRuntimeEvents({
      events: browserActivityEvents.filter(
        (event) => event.actor === 'browser',
      ),
      diagnostics: context.diagnostics!,
    });
    await context.updateRunProviderMetadata!({ force: true });
    if (output.status === 'error') {
      recordJobAgentRunFailure();
      if (!context.error) context.error = output.error || 'Unknown error';
      await context.failRun!();
    } else if (output.result && !context.hasStreamedResult) {
      context.appendResultSummary!(output.result);
    }
    if (!context.error)
      context.error = formatTerminalToolDenial(context.diagnostics!) ?? null;
    if (!context.error) {
      const boundedResultSummary = context.resultSummaryAccumulator!.snapshot();
      await completeSuccessfulRuntimeSessionRun({
        ops: deps.opsRepository,
        group: execution.group,
        chatJid: execution.executionJid,
        threadId: execution.threadId,
        conversationKind: execution.group.conversationKind,
        memoryUserId: context.memoryUserId,
        jobId: currentJob.id,
        agentSessionId: context.turnContext?.agentSessionId,
        agentSessionResetAt: context.turnContext?.agentSessionResetAt ?? null,
        runId: context.agentRunId,
        result: boundedResultSummary,
      });
      await collectJobCompletionMemory({
        agentSessionId: context.turnContext?.agentSessionId,
        collectMemory: deps.collectSessionMemory,
        defaultScope: context.memoryDefaultScope!,
        prompt: currentJob.prompt,
        result: boundedResultSummary,
        logger,
        context: { jobId: currentJob.id, runId },
      });
    } else if (output.status !== 'error') {
      await context.failRun!();
    }
  }
}

export async function finalizeActiveJobRun(
  context: ActiveJobRunContext,
): Promise<void> {
  const { currentJob, deps, runId, runtimeAppId } = context;
  const deletionGuard = context.deletionGuard!;
  const lease = context.leaseContext!.lease;
  const now = nowIso();
  await deletionGuard.isJobDeleted(true);
  context.deleted = deletionGuard.deletedDuringRun;
  if (deletionGuard.deletedDuringRun) context.result = context.error = null;
  context.safeResultSummary = deletionGuard.deletedDuringRun
    ? null
    : context.result || context.resultSummaryAccumulator!.snapshot() || null;
  // prettier-ignore
  const denialAppendError = deletionGuard.deletedDuringRun ? null : await publishTerminalToolDenials({ denials: context.diagnostics!.terminalToolDenials, error: context.error, currentJob, runId, runtimeAppId, eventState: context.eventState!, eventControl: context.eventControl!, publishRuntimeEvent: context.publishRuntimeEvent });
  const denialAppendFailed = denialAppendError !== null;
  if (denialAppendError) context.error = denialAppendError;
  context.finalizedState = await finalizeSchedulerJobRun({
    currentJob,
    deps,
    scheduledFor: context.scheduledFor,
    now,
    error: context.error,
    diagnostics: context.diagnostics!,
    pausedForSetupDuringRun: context.pausedForSetupDuringRun!,
    setupStateForSetupPause: context.setupStateForSetupPause,
    deletedDuringRun: deletionGuard.deletedDuringRun,
    runtimeAppId,
    runId,
    appSession:
      context.eventState!.eventAppSession ?? context.preflightAppSession,
    publishRuntimeEvent: context.publishRuntimeEvent,
    denialAppendFailed,
    listRuntimeEvents: (filter) =>
      context.runtime.getRuntimeEventExchange().list(filter),
    updateJobState: async (jobUpdates, state) => {
      if (deletionGuard.deletedDuringRun) return;
      const finalizeWithLease = deps.opsRepository.finalizeJobRunWithLease;
      await requireTerminalSettlement(
        finalizeWithLease?.call(deps.opsRepository, {
          jobId: currentJob.id,
          runId,
          leaseToken: lease.leaseToken,
          workerInstanceId: lease.workerInstanceId,
          fencingVersion: lease.fencingVersion,
          leaseOutcome:
            state.runStatus === 'paused'
              ? 'released'
              : context.error
                ? 'failed'
                : 'completed',
          runStatus: state.runStatus,
          resultSummary: context.safeResultSummary
            ? context.safeResultSummary.slice(0, 500)
            : null,
          errorSummary: state.safeErrorSummary
            ? state.safeErrorSummary.slice(0, 500)
            : null,
          jobUpdates,
          incrementConsecutiveFailures: state.incrementConsecutiveFailures,
        }),
        'Scheduler run lease finalization is unavailable for terminal job write.',
        'Scheduler run lease is no longer active during terminal finalization.',
      );
      context.settled = true;
    },
  });
  if (!context.settled && !deletionGuard.deletedDuringRun) {
    const finalizeRunLease = deps.opsRepository.finalizeJobRunLease;
    await requireTerminalSettlement(
      finalizeRunLease?.call(deps.opsRepository, {
        runId,
        leaseToken: lease.leaseToken,
        workerInstanceId: lease.workerInstanceId,
        fencingVersion: lease.fencingVersion,
        leaseOutcome:
          context.finalizedState.runStatus === 'paused'
            ? 'released'
            : context.error
              ? 'failed'
              : 'completed',
        runStatus: context.finalizedState.runStatus,
        resultSummary: context.safeResultSummary
          ? context.safeResultSummary.slice(0, 500)
          : null,
        errorSummary: context.finalizedState.safeErrorSummary
          ? context.finalizedState.safeErrorSummary.slice(0, 500)
          : null,
      }),
      'Scheduler run lease finalization is unavailable for terminal run write.',
      'Scheduler run lease is no longer active during terminal finalization.',
    );
    context.settled = true;
  }
  if (context.runLeaseAbort!.isAborted())
    await failSessionRun(deps.opsRepository, context.agentRunId, context.error);
}

export async function publishActiveJobTerminal(
  context: ActiveJobRunContext,
): Promise<void> {
  const { currentJob, deps, runId, runtimeAppId } = context;
  const deletionGuard = context.deletionGuard!;
  const lease = context.leaseContext!.lease;
  // prettier-ignore
  const { runStatus, nextRun, retryCount, pauseReason, safeErrorSummary, toolDenial, setupNotified } = context.finalizedState!;
  context.summary = terminalSummary(
    safeErrorSummary,
    context.safeResultSummary!,
  );
  if (!deletionGuard.deletedDuringRun) {
    await context.leaseContext!.recordRunnerControlEvent('terminal_state', {
      outcome: context.error ? 'failed' : 'completed',
      fencingVersion: lease.fencingVersion,
    });
  }
  context.lifecycle!.captureTerminal(runStatus, context.summary);
  await context.emitJobEvent!(runtimeEventTypeForRunStatus(runStatus), {
    next_run: nextRun,
    retry_count: retryCount,
    pause_reason: pauseReason,
    diagnostics: terminalDiagnosticsPayload(context.diagnostics!),
  });
  // prettier-ignore
  await closeBrowserAfterJobRun({ currentJob, executionGroupFolder: context.execution?.group.folder, executionJid: context.execution?.executionJid, executionProviderAccountId: context.execution?.group.providerAccountId, diagnostics: context.diagnostics!, deps, snapshotRunId: runId, snapshotFencingVersion: lease.fencingVersion, emitJobEvent: context.emitJobEvent!, logger });
  // prettier-ignore
  const recordedActions = await listRecordedJobRunActions({ appId: context.eventState!.eventAppSession?.appId ?? runtimeAppId, jobId: currentJob.id, runId, listRuntimeEvents: (filter) => context.runtimeEventExchange.list(filter) });
  // prettier-ignore
  logMemoryDreamJobFailure({ job: currentJob, runId, error: context.error, logger });
  context.notified =
    !(await deletionGuard.shouldSuppressDelivery()) &&
    (await notifySchedulerTerminalRunState({
      job: currentJob,
      runId,
      runStatus,
      summary: context.summary,
      nextRun,
      retryCount,
      pauseReason,
      setupNotified,
      diagnostics: context.diagnostics!,
      toolDenial,
      recordedActions,
      durationMs: Math.max(0, nowMs() - context.startedAtMs),
      runShortId: context.runShortId!,
      sendMessage: deps.sendMessage,
      updateLifecycleNotification:
        context.lifecycle!.updateLifecycleNotification,
      ...(context.memoryReviewNotification
        ? { memoryReviewNotification: context.memoryReviewNotification }
        : {}),
    }));
  if (context.notified) {
    const markJobRunNotified = deps.opsRepository.markJobRunNotified;
    await requireTerminalSettlement(
      markJobRunNotified?.call(deps.opsRepository, runId, {
        leaseToken: lease.leaseToken,
        workerInstanceId: lease.workerInstanceId,
        fencingVersion: lease.fencingVersion,
      }),
      'Scheduler run lease notification finalization is unavailable.',
      'Scheduler run lease is no longer valid during notification finalization.',
    );
  }
  await context.emitJobEvent!(
    runStatus === 'completed'
      ? RUNTIME_EVENT_TYPES.JOB_COMPLETED
      : RUNTIME_EVENT_TYPES.JOB_FAILED,
    {
      status: runStatus,
      delivery_state: context.notified ? 'sent' : 'not_sent',
      start_notification_state: context.startNotified ? 'sent' : 'not_sent',
      next_run: nextRun,
      retry_count: retryCount,
      pause_reason: pauseReason,
      notified: context.notified,
      summary: context.summary,
      ...jobCompletedModelPayload(
        context.resolvedModel!,
        context.accumulatedUsage,
      ),
      diagnostics: terminalDiagnosticsPayload(context.diagnostics!),
    },
  );
  await publishSchedulerCompletionEvent({
    currentJob,
    runId,
    runStatus,
    notified: context.notified,
    startNotified: context.startNotified!,
    summary: context.summary,
    nextRun,
    state: context.eventState!,
    runtimeAppId,
    control: context.eventControl!,
    publishRuntimeEvent: context.publishRuntimeEvent,
    logger,
  });
  deps.onSchedulerChanged?.(currentJob.id);
}

export async function deleteCompletedOneShotJob(
  context: ActiveJobRunContext,
): Promise<void> {
  const runStatus = context.finalizedState!.runStatus;
  if (
    !context.deletionGuard!.deletedDuringRun &&
    context.currentJob.schedule_type === 'once' &&
    (runStatus === 'completed' || runStatus === 'dead_lettered') &&
    normalizeCleanupAfterMs(context.currentJob.cleanup_after_ms) === 0
  ) {
    await context.deps.opsRepository.deleteJob(context.currentJob.id);
    context.deps.onSchedulerChanged?.(context.currentJob.id);
  }
}
