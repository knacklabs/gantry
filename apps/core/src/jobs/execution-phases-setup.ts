import { DEFAULT_JOB_RUNTIME_APP_ID } from '../application/jobs/job-access.js';
import type { RuntimeEventExchange } from '../application/runtime-events/runtime-event-exchange.js';
import type { JobToolPolicyResolution } from '../application/jobs/job-tool-policy.js';
import type { WorkerCoordinationRepository } from '../domain/ports/worker-coordination.js';
import type { Job } from '../domain/types.js';
import type { ExecutionProviderId } from '../domain/sessions/sessions.js';
import { logger } from '../infrastructure/logging/logger.js';
import type { AgentOutput } from '../runtime/agent-spawn.js';
import type {
  loadAgentAccessSnapshot,
  resolveTurnSelectedMcpServerIdsFromSnapshot,
  resolveTurnSelectedSkillContextFromSnapshot,
  resolveTurnSemanticCapabilitiesFromSnapshot,
} from '../runtime/group-run-context.js';
import {
  resolveModelFamilyCandidatesForApp,
  type ConfiguredModelProvidersLookup,
} from '../runtime/model-family-resolution.js';
import type { createRuntimeUserVisibleResultAccumulator } from '../runtime/session-resume-runtime.js';
import { nowMs, toIso } from '../shared/time/datetime.js';
import type { evaluateToolAccessRequirements } from '../application/jobs/job-tool-access-requirements.js';
import type { MemoryReviewCreatedNotification } from './memory-dreaming-job-outcome.js';
import type { SchedulerEventAppSession } from './app-session-resolution.js';
import { resolveAppSessionForJob } from './app-session-resolution.js';
import type { createJobExecutionDeletionGuard } from './execution-deletion-guard.js';
import type { createStreamingEventFlusher } from './execution-diagnostics.js';
import type { JobRunDiagnostics } from './execution-diagnostics.js';
import { resolveExecutionContext } from './execution-context.js';
import { resolveExecutionContextOrDeadLetter } from './execution-dead-letter.js';
import type { FinalizedJobRunState } from './execution-finalization.js';
import {
  claimSchedulerRunLease,
  createSchedulerRunLeaseAbort,
  jobPermissionLeaseExtensionMs,
  startSchedulerRunLeaseHeartbeat,
  type SchedulerRunLeaseContext,
  type SchedulerRunLeaseHeartbeat,
} from './execution-lease.js';
import type { createSchedulerLifecycleRetirementTracker } from './execution-notifications.js';
import { createSchedulerLifecycleRetirementTracker as trackLifecycle } from './execution-notifications.js';
import { pauseJobForSetupIfNeeded } from './execution-readiness.js';
import type {
  bindSchedulerRunEventState,
  createSchedulerJobEventEmitter,
  SchedulerRunEventState,
} from './execution-runtime-events.js';
import { createRuntimeEventPublisher as createEventPublisher } from './execution-runtime-events.js';
import {
  modelUseKindForJobSchedule,
  resolveJobExecutionProviderId,
  resolveJobModel,
} from './model-resolution.js';
import type { createRunProviderMetadataUpdater } from './run-provider-metadata.js';
import type {
  JobTurnContext,
  SchedulerDependencies,
  SchedulerDispatchPayload,
} from './types.js';

export interface ActiveJobAgentPreparation {
  accessSnapshot: Awaited<ReturnType<typeof loadAgentAccessSnapshot>>;
  credentialBroker:
    | Awaited<
        ReturnType<NonNullable<SchedulerDependencies['getCredentialBroker']>>
      >
    | undefined;
  executionAppId: string;
  executionAgentId: string;
  toolPolicy: JobToolPolicyResolution;
  selectedSkillContext: ReturnType<
    typeof resolveTurnSelectedSkillContextFromSnapshot
  >;
  semanticCapabilities: ReturnType<
    typeof resolveTurnSemanticCapabilitiesFromSnapshot
  >;
  attachedMcpSourceIds: ReturnType<
    typeof resolveTurnSelectedMcpServerIdsFromSnapshot
  >;
  toolAccessRequirements: ReturnType<
    typeof evaluateToolAccessRequirements
  >['toolAccessRequirements'];
}

type ActiveJobEventControl = Parameters<typeof resolveAppSessionForJob>[1] &
  Parameters<typeof resolveExecutionContextOrDeadLetter>[0]['control'] &
  Parameters<typeof bindSchedulerRunEventState>[0]['control'];

export interface ActiveJobRuntimeAccess {
  getEffectiveModelConfig: (
    useKind: ReturnType<typeof modelUseKindForJobSchedule>,
    agentFolder: string,
  ) => Parameters<typeof resolveJobModel>[1];
  getModelFamilies: () => Parameters<
    typeof resolveModelFamilyCandidatesForApp
  >[0]['familyOrder'];
  getSelectedAgentHarness: (
    agentFolder: string,
  ) => Parameters<typeof resolveJobModel>[2];
  getConfiguredModelProvidersForApp: ConfiguredModelProvidersLookup;
  getRuntimeControlRepository: () => ActiveJobEventControl;
  getRuntimeEventExchange: () => RuntimeEventExchange;
  getWorkerCoordinationRepository: () => WorkerCoordinationRepository;
}

export interface ActiveJobRunContext {
  currentJob: Job;
  deps: SchedulerDependencies;
  queueJid: string;
  dispatch: SchedulerDispatchPayload | undefined;
  control: { abortSignal?: AbortSignal } | undefined;
  scheduledFor: string;
  runId: string;
  assistantName: string;
  runtime: ActiveJobRuntimeAccess;
  startedAtMs: number;
  startedAt: string;
  runtimeAppId: string;
  runtimeEventExchange: RuntimeEventExchange;
  publishRuntimeEvent: ReturnType<typeof createEventPublisher>;
  warn: (context: Record<string, unknown>, message: string) => void;
  groups: ReturnType<SchedulerDependencies['conversationRoutes']>;
  execution?: NonNullable<ReturnType<typeof resolveExecutionContext>>;
  timeoutMs?: number;
  leaseExpiresAt?: string;
  jobModelUseKind?: ReturnType<typeof modelUseKindForJobSchedule>;
  jobFailoverCandidates?: string[];
  agentHarness?: ReturnType<ActiveJobRuntimeAccess['getSelectedAgentHarness']>;
  resolvedModel?: ReturnType<typeof resolveJobModel>;
  eventControl?: ActiveJobEventControl;
  preflightAppSession?: SchedulerEventAppSession;
  executionProviderId?: ExecutionProviderId;
  leaseContext?: SchedulerRunLeaseContext;
  runLeaseAbort?: ReturnType<typeof createSchedulerRunLeaseAbort>;
  leaseHeartbeat?: SchedulerRunLeaseHeartbeat;
  lifecycle?: ReturnType<typeof createSchedulerLifecycleRetirementTracker>;
  settled: boolean;
  deleted: boolean;
  runShortId?: number | null;
  eventState?: SchedulerRunEventState;
  deletionGuard?: ReturnType<typeof createJobExecutionDeletionGuard>;
  emitJobEvent?: ReturnType<typeof createSchedulerJobEventEmitter>;
  result: string | null;
  error: string | null;
  diagnostics?: JobRunDiagnostics;
  pausedForSetupDuringRun: boolean;
  setupStateForSetupPause?: NonNullable<Job['setup_state']>;
  resultSummaryAccumulator?: ReturnType<
    typeof createRuntimeUserVisibleResultAccumulator
  >;
  hasStreamedResult: boolean;
  agentRunId?: string;
  streamedRuntimeEventKeys: Set<string>;
  appendResultSummary?: (delta: string | null | undefined) => void;
  accumulatedUsage?: AgentOutput['usage'];
  memoryReviewNotification?: MemoryReviewCreatedNotification;
  startNotified: boolean;
  memoryDefaultScope?: 'user' | 'group';
  memoryUserId?: string;
  turnContext?: JobTurnContext;
  failRun?: () => Promise<void>;
  updateRunProviderMetadata?: ReturnType<
    typeof createRunProviderMetadataUpdater
  >;
  streamingFlusher?: ReturnType<typeof createStreamingEventFlusher>;
  agentPreparation?: ActiveJobAgentPreparation;
  finalizedState?: FinalizedJobRunState;
  safeResultSummary?: string | null;
  summary?: string;
  notified?: boolean;
}

export function createActiveJobRunContext(input: {
  currentJob: Job;
  deps: SchedulerDependencies;
  queueJid: string;
  dispatch: SchedulerDispatchPayload | undefined;
  control: { abortSignal?: AbortSignal } | undefined;
  scheduledFor: string;
  runId: string;
  assistantName: string;
  runtime: ActiveJobRuntimeAccess;
}): ActiveJobRunContext {
  const startedAtMs = nowMs();
  const startedAt = toIso(startedAtMs);
  const runtimeAppId = DEFAULT_JOB_RUNTIME_APP_ID;
  const runtimeEventExchange = input.runtime.getRuntimeEventExchange();
  const publishRuntimeEvent = createEventPublisher(runtimeEventExchange);
  const warn = (context: Record<string, unknown>, message: string): void =>
    logger.warn(context, message);
  const groups = input.deps.conversationRoutes();
  return {
    ...input,
    startedAtMs,
    startedAt,
    runtimeAppId,
    runtimeEventExchange,
    publishRuntimeEvent,
    warn,
    groups,
    settled: false,
    deleted: false,
    result: null,
    error: null,
    pausedForSetupDuringRun: false,
    hasStreamedResult: false,
    streamedRuntimeEventKeys: new Set<string>(),
    startNotified: false,
  };
}

export async function resolveActiveJobExecution(
  context: ActiveJobRunContext,
): Promise<boolean> {
  context.execution = await resolveExecutionContextOrDeadLetter({
    resolve: () =>
      resolveExecutionContext(context.currentJob, context.groups) ?? undefined,
    currentJob: context.currentJob,
    deps: context.deps,
    runId: context.runId,
    scheduledFor: context.scheduledFor,
    startedAt: context.startedAt,
    startedAtMs: context.startedAtMs,
    dispatch: context.dispatch,
    runtimeAppId: context.runtimeAppId,
    control: context.runtime.getRuntimeControlRepository(),
    publishRuntimeEvent: context.publishRuntimeEvent,
    logger,
  });
  return context.execution !== undefined;
}

export async function resolveActiveJobModel(
  context: ActiveJobRunContext,
): Promise<void> {
  const execution = context.execution!;
  context.timeoutMs = Math.max(
    30_000,
    context.currentJob.timeout_ms || 300_000,
  );
  context.leaseExpiresAt = toIso(nowMs() + context.timeoutMs + 30_000);
  context.jobModelUseKind = modelUseKindForJobSchedule(
    context.currentJob.schedule_type,
  );
  context.jobFailoverCandidates = await resolveModelFamilyCandidatesForApp({
    alias: context.currentJob.model || '',
    appId: context.runtimeAppId,
    listConfiguredProviders: context.runtime.getConfiguredModelProvidersForApp,
    familyOrder: context.runtime.getModelFamilies(),
  });
  const jobModelForResolution = context.jobFailoverCandidates[0] ?? '';
  context.agentHarness = context.runtime.getSelectedAgentHarness(
    execution.group.folder,
  );
  context.resolvedModel = resolveJobModel(
    {
      ...context.currentJob,
      model: jobModelForResolution || context.currentJob.model,
    },
    context.runtime.getEffectiveModelConfig(
      context.jobModelUseKind,
      execution.group.folder,
    ),
    context.agentHarness,
  );
  context.eventControl = context.runtime.getRuntimeControlRepository();
}

export async function prepareActiveJobSession(
  context: ActiveJobRunContext,
): Promise<boolean> {
  const execution = context.execution!;
  context.preflightAppSession = await resolveAppSessionForJob(
    context.currentJob,
    context.eventControl!,
  );
  const pausedForSetup = await pauseJobForSetupIfNeeded({
    currentJob: context.currentJob,
    deps: context.deps,
    executionAgentFolder: execution.group.folder,
    runtimeAppId: context.runtimeAppId,
    appSession: context.preflightAppSession,
    source: 'preflight_setup',
    runId: context.runId,
    publishRuntimeEvent: context.publishRuntimeEvent,
  });
  return !pausedForSetup;
}

export async function claimActiveJobLease(
  context: ActiveJobRunContext,
): Promise<boolean> {
  const execution = context.execution!;
  context.executionProviderId = resolveJobExecutionProviderId({
    resolvedModel: context.resolvedModel!,
    executionAdapter: context.deps.executionAdapter,
    executionAdapters: context.deps.executionAdapters,
  });
  const leaseContext = await claimSchedulerRunLease({
    deps: context.deps,
    currentJob: context.currentJob,
    runId: context.runId,
    executionProviderId: context.executionProviderId,
    workerId: execution.group.folder,
    leaseOwner: execution.executionJid,
    scheduledFor: context.scheduledFor,
    startedAt: context.startedAt,
    leaseExpiresAt: context.leaseExpiresAt!,
    requireNextRun:
      context.currentJob.schedule_type !== 'manual' &&
      !context.dispatch?.triggerId,
    getCoordinationRepository: context.runtime.getWorkerCoordinationRepository,
    warn: context.warn,
  });
  if (!leaseContext) return false;
  context.leaseContext = leaseContext;
  context.runLeaseAbort = createSchedulerRunLeaseAbort();
  context.leaseHeartbeat = startSchedulerRunLeaseHeartbeat({
    runId: context.runId,
    leaseContext,
    ttlMs: context.timeoutMs! + 30_000,
    deadlineMs: context.startedAtMs + context.timeoutMs!,
    getCoordinationRepository: context.runtime.getWorkerCoordinationRepository,
    warn: context.warn,
    onLeaseLost: context.runLeaseAbort.abort,
    externalAbortSignal: context.control?.abortSignal,
    pendingLeaseExtensionMs: () =>
      jobPermissionLeaseExtensionMs({
        appId: context.runtimeAppId,
        jobId: context.currentJob.id,
        sourceAgentFolder: execution.group.folder,
        runId: context.runId,
      }),
  });
  context.settled = false;
  context.deleted = false;
  context.lifecycle = trackLifecycle(
    context.currentJob,
    context.runId,
    context.deps,
  );
  return true;
}
