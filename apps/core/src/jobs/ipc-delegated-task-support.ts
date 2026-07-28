import type { AsyncTaskRecord } from '../domain/ports/async-tasks.js';
import type {
  CoreDelegatedRunInput,
  CoreTaskOwner,
} from '../application/core-tools/task-lifecycle.js';
import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
import { nowIso } from '../shared/time/datetime.js';
import type { AgentOutput } from '../runtime/agent-spawn-types.js';
import { spawnAgent } from '../runtime/agent-spawn.js';
import type { TaskContext } from './ipc-types.js';
import type { resolveDelegatedAgentTarget } from './ipc-agent-delegation-target.js';
import { AsyncCommandTaskService } from './async-command-task-service.js';

const DEFAULT_DELEGATED_AGENT_TIMEOUT_MS = 30 * 60_000;

type ResolvedDelegatedAgentTarget = Extract<
  Awaited<ReturnType<typeof resolveDelegatedAgentTarget>>,
  { ok: true }
>;

type DelegatedAgentRunner = (
  input: CoreDelegatedRunInput,
) => Promise<{ outputSummary?: string | null; errorSummary?: string | null }>;

export function createDelegatedTaskTerminalPublisher(
  context: TaskContext,
): (task: AsyncTaskRecord) => Promise<void> {
  return async (task) => {
    if (!task.parentJobId || !context.deps.publishRuntimeEvent) return;
    await context.deps.publishRuntimeEvent({
      appId: task.appId as never,
      agentId: task.agentId as never,
      ...(task.conversationId
        ? { conversationId: task.conversationId as never }
        : {}),
      ...(task.threadId ? { threadId: task.threadId as never } : {}),
      ...(task.parentRunId ? { runId: task.parentRunId as never } : {}),
      jobId: task.parentJobId as never,
      eventType: RUNTIME_EVENT_TYPES.TASK_UPDATED,
      actor: 'gantry-runtime',
      payload: {
        taskId: task.id,
        taskKey:
          typeof task.privateCorrelationJson.taskKey === 'string'
            ? task.privateCorrelationJson.taskKey
            : null,
        kind: task.kind,
        status: task.status,
      },
    });
  };
}

export async function createInheritedDelegatedAgentRunner(input: {
  context: TaskContext;
  owner: CoreTaskOwner;
  target: ResolvedDelegatedAgentTarget;
}): Promise<DelegatedAgentRunner> {
  const { context, owner, target } = input;
  const {
    group,
    targetOwner,
    toolPolicy,
    selectedSkillContext,
    semanticCapabilities,
    attachedMcpSourceIds,
  } = target;
  const parentJob = context.data.jobId
    ? await context.deps.opsRepository.getJobById(context.data.jobId)
    : undefined;
  const requiredSkill = parentJob?.agent_task?.requiredSkill;
  const requiredSkillId = requiredSkill
    ? (
        (await context.deps.getSkillRepository?.()?.listEnabledSkillsForAgent({
          appId: owner.appId as never,
          agentId: target.targetAgentId as never,
        })) ?? []
      ).find(
        (skill) =>
          skill.name === requiredSkill.name &&
          skill.storage?.contentHash === requiredSkill.contentHash,
      )?.id
    : undefined;
  if (requiredSkill && !requiredSkillId) {
    throw new Error(
      `Required skill ${requiredSkill.name}@${requiredSkill.contentHash} is not installed and bound exactly as requested.`,
    );
  }

  return async ({
    task,
    prompt,
    signal,
    onProcessStarted,
    onProgress,
    timeoutMs,
  }) => {
    const runAgent = context.deps.runAgent ?? spawnAgent;
    const taskKey =
      typeof task.privateCorrelationJson.taskKey === 'string'
        ? task.privateCorrelationJson.taskKey
        : undefined;
    const completionGate = parentJob?.agent_task?.delegatedCompletionGate;
    const delegatedCompletionGate =
      taskKey &&
      completionGate &&
      completionGate.taskKeys.includes(taskKey) &&
      parentJob?.agent_task?.callerResolvedTools &&
      parentJob.session_id
        ? {
            toolName: completionGate.toolName,
            maxNoProgressContinuations:
              completionGate.maxNoProgressContinuations,
            interactionTimeoutMs:
              parentJob.agent_task.callerResolvedTools.interactionTimeoutMs,
          }
        : undefined;
    let latestResult: string | null = null;
    let processHandlePersisted: Promise<void> | null = null;
    const output = await runAgent(
      group,
      {
        prompt,
        appId: owner.appId,
        agentId: target.targetAgentId,
        chatJid: owner.conversationId,
        threadId: owner.threadId ?? undefined,
        workspaceFolder: group.folder,
        parentTaskId: task.id,
        ...(parentJob?.model ? { model: parentJob.model } : {}),
        ...(context.data.jobId
          ? {
              isScheduledJob: true,
              jobId: context.data.jobId,
              runId: context.data.runId,
            }
          : {}),
        persona: group.agentConfig?.persona,
        thinking: group.agentConfig?.thinking,
        toolPolicyRules: toolPolicy.toolPolicyRules,
        runtimeAccess: toolPolicy.runtimeAccess,
        attachedSkillSourceIds: parentJob?.agent_task?.requiredSkill
          ? [requiredSkillId!]
          : selectedSkillContext.ids,
        selectedSkillDisplays: selectedSkillContext.displays,
        attachedMcpSourceIds,
        semanticCapabilities,
        effort: parentJob?.agent_task?.modelControls?.effort,
        configuredThinking: parentJob?.agent_task?.modelControls?.thinking,
        maxOutputTokens: parentJob?.agent_task?.modelControls?.maxOutputTokens,
        ...(parentJob?.agent_task?.callerResolvedTools && parentJob.session_id
          ? {
              callerResolvedTools: {
                sessionId: parentJob.session_id,
                ...parentJob.agent_task.callerResolvedTools,
              },
            }
          : {}),
        ...(delegatedCompletionGate ? { delegatedCompletionGate } : {}),
      },
      (proc) => {
        if (proc.pid) {
          processHandlePersisted = Promise.resolve(
            onProcessStarted?.({
              pid: proc.pid,
              processGroupId: proc.pid,
              detached: true,
              platform: process.platform,
              ownerPid: process.pid,
              startedAt: nowIso(),
            }),
          );
          processHandlePersisted.catch(() => {
            proc.kill('SIGTERM');
          });
        }
      },
      async (output: AgentOutput) => {
        if (output.result) {
          latestResult = `${latestResult ?? ''}${output.result}`;
          await onProgress?.(output.result);
        }
      },
      {
        timeoutMs: timeoutMs ?? DEFAULT_DELEGATED_AGENT_TIMEOUT_MS,
        signal,
        credentialBroker: await context.deps.getCredentialBroker?.(),
        skillRepository: context.deps.getSkillRepository?.(),
        skillArtifactStore: context.deps.getSkillArtifactStore?.(),
        skillContext: targetOwner,
        mcpServerRepository: context.deps.getMcpServerRepository?.(),
        capabilitySecretRepository:
          context.deps.getCapabilitySecretRepository?.(),
        mcpContext: targetOwner,
        mcpHostnameLookup: context.deps.mcpHostnameLookup,
        mcpDnsValidationCache: context.deps.getMcpDnsValidationCache?.(),
        publishRuntimeEvent: context.deps.publishRuntimeEvent,
        executionAdapter: context.deps.executionAdapter,
        executionAdapters: context.deps.executionAdapters,
        runnerSandboxProvider: context.deps.runnerSandboxProvider!,
        asyncTaskRepositoryAvailable: Boolean(
          context.deps.getAsyncTaskRepository?.(),
        ),
      },
    );
    if (processHandlePersisted) await processHandlePersisted;
    if (output.status === 'error') {
      return AsyncCommandTaskService.delegatedAgentFailureResult(
        output,
        latestResult,
        task.summary ?? 'Complete delegated task.',
      );
    }
    return {
      outputSummary:
        output.result ?? latestResult ?? 'delegated task completed',
    };
  };
}
