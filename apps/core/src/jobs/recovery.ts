import type { RuntimeEventPublishInput } from '../domain/events/events.js';
import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import { getEffectiveModelConfig } from '../config/index.js';
import type { ExecutionProviderId } from '../domain/sessions/sessions.js';
import type { Job } from '../domain/types.js';
import { spawnAgent } from '../runtime/agent-spawn.js';
import type { AgentOutput } from '../runtime/agent-spawn.js';
import type { AgentInput } from '../runtime/agent-spawn-types.js';
import {
  buildApprovedSkillContextBlock,
  buildRuntimeRunOptions,
  completeFailedRuntimeSessionRun,
  completeSuccessfulRuntimeSessionRun,
  createRuntimeUserVisibleResultAccumulator,
} from '../runtime/session-resume-runtime.js';
import {
  resolveTurnSemanticCapabilities,
  resolveTurnSelectedMcpServerIds,
  resolveTurnSelectedSkillContext,
} from '../runtime/group-run-context.js';
import {
  DEFAULT_RUNTIME_EXECUTION_PROVIDER_ID,
  resolveRuntimeExecutionProviderId,
} from '../runtime/execution-provider-id.js';
import { makeThreadQueueKey } from '../shared/thread-queue-key.js';
import {
  createJobRecoveryIntent,
  shouldRunRecoveryIntent,
  transitionJobRecoveryIntent,
  type JobRecoveryIntentSource,
} from '../application/jobs/job-recovery-intent-service.js';
import * as jobToolPolicy from '../application/jobs/job-tool-policy.js';
import {
  buildExecutionTurnContextInput,
  resolveExecutionContext,
  resolveExecutionMemoryContext,
} from './execution-context.js';
import type { JobTurnContext, SchedulerDependencies } from './types.js';
import {
  modelUseKindForJobSchedule,
  resolveJobModel,
} from './model-resolution.js';

const MAX_RECOVERY_TURN_TIMEOUT_MS = 300_000;
const DEFAULT_RECOVERY_ASSISTANT_NAME = 'Gantry';
const WORKSPACE_FOLDER_INPUT_KEY = `group${'Folder'}` as const;

export async function queueJobRecoveryTurn(input: {
  currentJob: Job;
  deps: SchedulerDependencies;
  execution: {
    group: JobExecutionGroup;
    executionJid: string;
    threadId: string | null;
    stopAliasJids: string[];
  };
  setupState: NonNullable<Job['setup_state']>;
  source: JobRecoveryIntentSource;
  runId?: string | null;
  runtimeAppId: string;
  publishRuntimeEvent?: (
    event: RuntimeEventPublishInput,
  ) => Promise<unknown> | unknown;
}): Promise<void> {
  const { intent, created } = await createJobRecoveryIntent({
    job: input.currentJob,
    setupState: input.setupState,
    source: input.source,
    runId: input.runId,
    opsRepository: input.deps.opsRepository,
  });
  if (!created) return;
  const intentJob: Job = { ...input.currentJob, recovery_intent: intent };

  await enqueueJobRecoveryIntentTask({
    currentJob: intentJob,
    deps: input.deps,
    execution: input.execution,
    runtimeAppId: input.runtimeAppId,
    publishRuntimeEvent: input.publishRuntimeEvent,
  });
}

export async function rehydratePendingJobRecoveryTurns(input: {
  jobs: readonly Job[];
  deps: SchedulerDependencies;
  runtimeAppId: string;
  publishRuntimeEvent?: (
    event: RuntimeEventPublishInput,
  ) => Promise<unknown> | unknown;
}): Promise<{
  checked: number;
  queued: number;
  deferred: number;
  skipped: number;
}> {
  let checked = 0;
  let queued = 0;
  let deferred = 0;
  let skipped = 0;
  const conversationRoutes = input.deps.conversationRoutes();

  for (const job of input.jobs) {
    const intent = job.recovery_intent;
    if (
      job.status !== 'paused' ||
      !job.setup_state ||
      !intent ||
      intent.state !== 'pending'
    ) {
      skipped++;
      continue;
    }
    if (!shouldRunRecoveryIntent(job, intent.dedupe_key)) {
      skipped++;
      continue;
    }
    const execution = resolveExecutionContext(job, conversationRoutes);
    if (!execution) {
      skipped++;
      continue;
    }
    checked++;
    const accepted = await enqueueJobRecoveryIntentTask({
      currentJob: job,
      deps: input.deps,
      execution,
      runtimeAppId: input.runtimeAppId,
      publishRuntimeEvent: input.publishRuntimeEvent,
    });
    if (accepted) {
      queued++;
    } else {
      deferred++;
    }
  }

  return { checked, queued, deferred, skipped };
}

async function enqueueJobRecoveryIntentTask(input: {
  currentJob: Job;
  deps: SchedulerDependencies;
  execution: {
    group: JobExecutionGroup;
    executionJid: string;
    threadId: string | null;
    stopAliasJids: string[];
  };
  runtimeAppId: string;
  publishRuntimeEvent?: (
    event: RuntimeEventPublishInput,
  ) => Promise<unknown> | unknown;
}): Promise<boolean> {
  const intent = input.currentJob.recovery_intent;
  if (!intent) return false;
  const enqueueTask = input.deps.queue?.enqueueTask?.bind(input.deps.queue);
  if (!enqueueTask) {
    await transitionJobRecoveryIntent({
      job: input.currentJob,
      dedupeKey: intent.dedupe_key,
      state: 'failed',
      error: 'Scheduler queue unavailable for recovery turn.',
      opsRepository: input.deps.opsRepository,
    });
    return false;
  }

  const queueKey = makeThreadQueueKey(
    input.execution.executionJid,
    input.execution.threadId,
  );
  const taskId = `job-recovery:${input.currentJob.id}:${intent.dedupe_key}`;
  try {
    const accepted = enqueueTask(queueKey, taskId, async () => {
      try {
        await runQueuedJobRecoveryTurn({
          jobId: input.currentJob.id,
          dedupeKey: intent.dedupe_key,
          deps: input.deps,
          execution: input.execution,
          runtimeAppId: input.runtimeAppId,
          publishRuntimeEvent: input.publishRuntimeEvent,
        });
      } catch (err) {
        const failedJob =
          (await input.deps.opsRepository.getJobById(input.currentJob.id)) ??
          input.currentJob;
        await transitionJobRecoveryIntent({
          job: failedJob,
          dedupeKey: intent.dedupe_key,
          state: 'failed',
          error: err instanceof Error ? err.message : String(err),
          opsRepository: input.deps.opsRepository,
        });
        await publishRecoveryEvent(input, failedJob, {
          phase: 'recovery_failed',
          dedupe_key: intent.dedupe_key,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });
    if (!accepted) {
      await publishRecoveryEvent(input, input.currentJob, {
        phase: 'recovery_deferred',
        recovery_kind: intent.kind,
        recovery_state: intent.state,
        dedupe_key: intent.dedupe_key,
        reason: 'scheduler queue is shutting down',
      });
      return false;
    }
    await publishRecoveryEvent(input, input.currentJob, {
      phase: 'recovery_queued',
      recovery_kind: intent.kind,
      recovery_state: intent.state,
      dedupe_key: intent.dedupe_key,
    });
    return true;
  } catch (err) {
    await transitionJobRecoveryIntent({
      job: input.currentJob,
      dedupeKey: intent.dedupe_key,
      state: 'failed',
      error: err instanceof Error ? err.message : String(err),
      opsRepository: input.deps.opsRepository,
    });
    await publishRecoveryEvent(input, input.currentJob, {
      phase: 'recovery_failed',
      dedupe_key: intent.dedupe_key,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

type JobExecutionGroup = Parameters<typeof spawnAgent>[0];

async function runQueuedJobRecoveryTurn(input: {
  jobId: string;
  dedupeKey: string;
  deps: SchedulerDependencies;
  execution: {
    group: JobExecutionGroup;
    executionJid: string;
    threadId: string | null;
    stopAliasJids: string[];
  };
  runtimeAppId: string;
  publishRuntimeEvent?: (
    event: RuntimeEventPublishInput,
  ) => Promise<unknown> | unknown;
}): Promise<void> {
  const job = await input.deps.opsRepository.getJobById(input.jobId);
  if (!job || !shouldRunRecoveryIntent(job, input.dedupeKey)) return;

  await transitionJobRecoveryIntent({
    job,
    dedupeKey: input.dedupeKey,
    state: 'running',
    opsRepository: input.deps.opsRepository,
  });
  await publishRecoveryEvent(input, job, {
    phase: 'recovery_running',
    dedupe_key: input.dedupeKey,
  });

  const latestJob =
    (await input.deps.opsRepository.getJobById(input.jobId)) ?? job;
  try {
    const output = await runJobRecoveryAgentTurn({
      job: latestJob,
      deps: input.deps,
      execution: input.execution,
      runtimeAppId: input.runtimeAppId,
      publishRuntimeEvent: input.publishRuntimeEvent,
    });
    const completedJob =
      (await input.deps.opsRepository.getJobById(input.jobId)) ?? latestJob;
    await transitionJobRecoveryIntent({
      job: completedJob,
      dedupeKey: input.dedupeKey,
      state: output.status === 'success' ? 'completed' : 'failed',
      error: output.status === 'success' ? null : output.error,
      opsRepository: input.deps.opsRepository,
    });
    await publishRecoveryEvent(input, completedJob, {
      phase:
        output.status === 'success' ? 'recovery_completed' : 'recovery_failed',
      dedupe_key: input.dedupeKey,
      ...(output.status === 'error' ? { error: output.error } : {}),
    });
  } catch (err) {
    const failedJob =
      (await input.deps.opsRepository.getJobById(input.jobId)) ?? latestJob;
    await transitionJobRecoveryIntent({
      job: failedJob,
      dedupeKey: input.dedupeKey,
      state: 'failed',
      error: err instanceof Error ? err.message : String(err),
      opsRepository: input.deps.opsRepository,
    });
    await publishRecoveryEvent(input, failedJob, {
      phase: 'recovery_failed',
      dedupe_key: input.dedupeKey,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function runJobRecoveryAgentTurn(input: {
  job: Job;
  deps: SchedulerDependencies;
  execution: {
    group: JobExecutionGroup;
    executionJid: string;
    threadId: string | null;
    stopAliasJids: string[];
  };
  runtimeAppId: string;
  publishRuntimeEvent?: (
    event: RuntimeEventPublishInput,
  ) => Promise<unknown> | unknown;
}): Promise<AgentOutput> {
  const runAgentImpl = input.deps.runAgent ?? spawnAgent;
  const resolvedModel = resolveJobModel(
    input.job,
    getEffectiveModelConfig(
      undefined,
      modelUseKindForJobSchedule(input.job.schedule_type),
      input.execution.group.folder,
    ),
  );
  const executionProviderId = (resolvedModel.entry?.executionProviderId ??
    (input.deps.executionAdapter || !input.deps.runAgent
      ? resolveRuntimeExecutionProviderId(input.deps.executionAdapter)
      : DEFAULT_RUNTIME_EXECUTION_PROVIDER_ID)) as ExecutionProviderId;
  const { memoryDefaultScope, memoryUserId } = resolveExecutionMemoryContext({
    conversationKind: input.execution.group.conversationKind,
    executionJid: input.execution.executionJid,
  });
  const prompt = buildJobRecoveryPrompt(input.job);
  const turnContext = await input.deps.opsRepository.getAgentTurnContext?.(
    buildExecutionTurnContextInput({
      agentFolder: input.execution.group.folder,
      executionProviderId,
      executionJid: input.execution.executionJid,
      threadId: input.execution.threadId,
      conversationKind: input.execution.group.conversationKind,
      memoryUserId,
      query: prompt,
    }),
  );
  const executionAppId = turnContext?.appId ?? input.runtimeAppId;
  const executionAgentId =
    turnContext?.agentId ??
    jobToolPolicy.agentIdForJobGroupScope(input.execution.group.folder);
  const [
    toolPolicy,
    selectedSkillContext,
    semanticCapabilities,
    credentialBroker,
    approvedSkillContext,
  ] = await Promise.all([
    jobToolPolicy.resolveJobToolPolicy({
      job: input.job,
      appId: executionAppId,
      agentId: executionAgentId,
      toolRepository: input.deps.getToolRepository?.(),
      skillRepository: input.deps.getSkillRepository?.(),
    }),
    resolveTurnSelectedSkillContext(input.deps, {
      appId: executionAppId,
      agentId: executionAgentId,
    }),
    resolveTurnSemanticCapabilities(input.deps, {
      appId: executionAppId,
      agentId: executionAgentId,
    }),
    input.deps.getCredentialBroker?.() ?? Promise.resolve(undefined),
    buildApprovedSkillContextBlock({
      skillRepository: input.deps.getSkillRepository?.(),
      skillArtifactStore: input.deps.getSkillArtifactStore?.(),
      turnContext: turnContextForSkillContext(turnContext),
    }),
  ]);
  const attachedMcpSourceIds = await resolveTurnSelectedMcpServerIds(
    input.deps,
    {
      appId: executionAppId,
      agentId: executionAgentId,
    },
    toolPolicy.effectiveAllowedTools,
  );
  const runOptions = buildRuntimeRunOptions({
    timeoutMs: recoveryTurnTimeoutMs(input.job),
    credentialBroker,
    skillRepository: input.deps.getSkillRepository?.(),
    skillArtifactStore: input.deps.getSkillArtifactStore?.(),
    mcpServerRepository: input.deps.getMcpServerRepository?.(),
    capabilitySecretRepository: input.deps.getCapabilitySecretRepository?.(),
    mcpHostnameLookup: input.deps.getMcpHostnameLookup?.(),
    mcpDnsValidationCache: input.deps.getMcpDnsValidationCache?.(),
    publishRuntimeEvent: input.publishRuntimeEvent,
    executionAdapter: input.deps.executionAdapter,
    executionAdapters: input.deps.executionAdapters,
    skillContext: {
      appId: executionAppId,
      agentId: executionAgentId,
    },
  });
  let agentRunId: string | undefined;
  if (turnContext?.agentSessionId) {
    agentRunId = await input.deps.opsRepository.createSessionAgentRun?.({
      agentSessionId: turnContext.agentSessionId,
      executionProviderId,
      providerSessionId: turnContext.providerSessionId,
      cause: 'control',
    });
  }
  const resultSummaryAccumulator = createRuntimeUserVisibleResultAccumulator();
  const agentInput = {
    prompt,
    [WORKSPACE_FOLDER_INPUT_KEY]: input.execution.group.folder,
    chatJid: input.execution.executionJid,
    threadId: input.execution.threadId || undefined,
    appId: executionAppId,
    agentId: executionAgentId,
    persona: input.execution.group.agentConfig?.persona,
    memoryUserId,
    memoryDefaultScope,
    assistantName:
      input.execution.group.trigger ||
      input.execution.group.name ||
      DEFAULT_RECOVERY_ASSISTANT_NAME,
    memoryContextBlock: [turnContext?.memoryContextBlock, approvedSkillContext]
      .filter((block): block is string => Boolean(block?.trim()))
      .join('\n\n'),
    allowedTools: toolPolicy.effectiveAllowedTools,
    runtimeAccess: toolPolicy.runtimeAccess,
    attachedSkillSourceIds: selectedSkillContext.ids,
    selectedSkillDisplays: selectedSkillContext.displays,
    attachedMcpSourceIds,
    semanticCapabilities,
    ...(turnContext?.externalSessionId
      ? { sessionId: turnContext.externalSessionId }
      : {}),
  } as AgentInput;
  const output = await runAgentImpl(
    input.execution.group,
    agentInput,
    (proc, runHandle) => {
      if (agentRunId) {
        void input.deps.opsRepository.updateAgentRunProviderMetadata?.({
          runId: agentRunId,
          providerRunId: runHandle,
        });
      }
      input.deps.onProcess(
        makeThreadQueueKey(
          input.execution.executionJid,
          input.execution.threadId,
        ),
        proc,
        runHandle,
        input.execution.group.folder,
        input.execution.stopAliasJids,
      );
    },
    async (streamedOutput) => {
      if (streamedOutput.result) {
        resultSummaryAccumulator.append(streamedOutput.result);
      }
      if (streamedOutput.newSessionId && agentRunId) {
        await input.deps.opsRepository.updateAgentRunProviderMetadata?.({
          runId: agentRunId,
          providerSessionId: streamedOutput.newSessionId,
        });
      }
    },
    runOptions,
  );
  if (output.result) resultSummaryAccumulator.append(output.result);
  if (output.newSessionId && agentRunId) {
    await input.deps.opsRepository.updateAgentRunProviderMetadata?.({
      runId: agentRunId,
      providerSessionId: output.newSessionId,
    });
  }
  if (output.status === 'error') {
    await completeFailedRuntimeSessionRun({
      ops: input.deps.opsRepository,
      runId: agentRunId,
      errorSummary: output.error || 'Job recovery turn failed.',
    });
    return output;
  }
  await completeSuccessfulRuntimeSessionRun({
    ops: input.deps.opsRepository,
    group: input.execution.group,
    chatJid: input.execution.executionJid,
    threadId: input.execution.threadId,
    conversationKind: input.execution.group.conversationKind,
    memoryUserId,
    agentSessionId: turnContext?.agentSessionId,
    agentSessionResetAt: turnContext?.agentSessionResetAt ?? null,
    runId: agentRunId,
    result: resultSummaryAccumulator.snapshot() || output.result,
  });
  return output;
}

async function publishRecoveryEvent(
  input: {
    runtimeAppId: string;
    execution?: {
      executionJid: string;
      threadId: string | null;
    };
    publishRuntimeEvent?: (
      event: RuntimeEventPublishInput,
    ) => Promise<unknown> | unknown;
  },
  job: Job,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!input.publishRuntimeEvent) return;
  try {
    await input.publishRuntimeEvent({
      appId: input.runtimeAppId as never,
      eventType: RUNTIME_EVENT_TYPES.JOB_TOOL_ACTIVITY,
      actor: 'scheduler',
      jobId: job.id as never,
      conversationId: (input.execution?.executionJid ??
        job.execution_context?.conversationJid) as never,
      threadId: (input.execution?.threadId ??
        job.execution_context?.threadId ??
        job.thread_id) as never,
      payload: {
        job_id: job.id,
        ...payload,
      },
    });
  } catch {
    // Recovery telemetry is best effort; the persisted intent is authoritative.
  }
}

function turnContextForSkillContext(turnContext: JobTurnContext | undefined):
  | {
      appId: string;
      agentId: string;
    }
  | undefined {
  return turnContext
    ? { appId: turnContext.appId, agentId: turnContext.agentId }
    : undefined;
}

function recoveryTurnTimeoutMs(job: Job): number {
  return Math.min(
    Math.max(30_000, job.timeout_ms || MAX_RECOVERY_TURN_TIMEOUT_MS),
    MAX_RECOVERY_TURN_TIMEOUT_MS,
  );
}

function buildJobRecoveryPrompt(job: Job): string {
  const intent = job.recovery_intent;
  const setupState = job.setup_state;
  const blockers = setupState?.blockers ?? [];
  return [
    '<gantry_scheduler_job_recovery>',
    'This is a host-generated recovery turn for your own scheduled job. It is not raw job output and it is not a user message.',
    '',
    'React once to the deterministic setup or permission blocker. Use the same Gantry tools you would use in a normal conversation. Do not edit settings.yaml, mutate Postgres directly, or grant yourself access.',
    '',
    'Allowed recovery actions:',
    '- If access is missing, use capability_search, propose_capability, manage_capability, request_permission, request_skill_install, request_skill_proposal, request_skill_dependency_install, or request_mcp_server as appropriate.',
    '- If a human decision is needed, ask the user or control approver clearly for the single next action.',
    '- If setup already looks ready, use scheduler_run_now or the scheduler tools to retry/resume the job.',
    '- If the job requirements are wrong, use scheduler update tools to correct the job requirement, then explain the change.',
    '',
    `Job id: ${escapeRecoveryPromptText(job.id)}`,
    `Job name: ${escapeRecoveryPromptText(job.name)}`,
    `Recovery kind: ${escapeRecoveryPromptText(intent?.kind ?? 'setup_required')}`,
    `Recovery state: ${escapeRecoveryPromptText(intent?.state ?? 'pending')}`,
    `Source run id: ${escapeRecoveryPromptText(intent?.source_run_id ?? 'none')}`,
    `Setup state: ${escapeRecoveryPromptText(setupState?.state ?? 'unknown')}`,
    `Setup fingerprint: ${escapeRecoveryPromptText(setupState?.fingerprint ?? 'unknown')}`,
    blockers.length > 0 ? 'Blockers:' : 'Blockers: none',
    ...blockers.map(
      (blocker) =>
        `- ${escapeRecoveryPromptText(blocker.requirementType)}:${escapeRecoveryPromptText(blocker.requirementId)} | ${escapeRecoveryPromptText(blocker.message)} | next: ${escapeRecoveryPromptText(blocker.nextAction)}`,
    ),
    '',
    'Original job prompt preview:',
    escapeRecoveryPromptText(truncateForPrompt(job.prompt, 1200)),
    '</gantry_scheduler_job_recovery>',
  ].join('\n');
}

function escapeRecoveryPromptText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function truncateForPrompt(value: string, maxChars: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, maxChars - 20).trimEnd()}... [truncated]`;
}
