import {
  callableAgentToolName,
  dispatchCallableAgentTool,
  type CallableAgentToolManifestEntry,
} from '../application/core-tools/callable-agent-tools.js';
import { createCoreTaskLifecycleBackend } from '../application/core-tools/task-lifecycle.js';
import { logger } from '../infrastructure/logging/logger.js';
import type { AgentOutput } from '../runtime/agent-spawn-types.js';
import { spawnAgent } from '../runtime/agent-spawn.js';
import { nowIso } from '../shared/time/datetime.js';
import { AsyncCommandTaskService } from './async-command-task-service.js';
import {
  resolveDelegatedAgentTarget,
  resolveDelegatedAgentTimeouts,
} from './ipc-agent-delegation-target.js';
import { toTrimmedString } from './ipc-shared.js';
import type { TaskContext } from './ipc-types.js';

const DEFAULT_DELEGATED_AGENT_TIMEOUT_MS = 30 * 60_000;

type ResolvedDelegationTarget = Extract<
  Awaited<ReturnType<typeof resolveDelegatedAgentTarget>>,
  { ok: true }
>;

interface DelegatedTaskOwner {
  appId: string;
  agentId: string;
  conversationId: string;
  providerAccountId?: string | null;
  threadId?: string | null;
}

export async function executeResolvedDelegation(input: {
  context: TaskContext;
  service: AsyncCommandTaskService;
  owner: DelegatedTaskOwner;
  target: ResolvedDelegationTarget;
  trustedProviderAccountId?: string | null;
  trustedJobId?: string;
  trustedParentRunId?: string;
  payload: Record<string, unknown>;
  objective: string;
  requestedTargetAgentId?: string;
}) {
  const { context } = input;
  let target = input.target;
  const backend = createCoreTaskLifecycleBackend({
    service: input.service,
    owner: { ...input.owner, providerAccountId: target.providerAccountId },
    authorityToolName: target.callableAgentEntry
      ? 'AgentDelegation'
      : undefined,
    enableDelegatedAsyncFollowUp: Boolean(
      target.callableAgentEntry && !input.trustedJobId,
    ),
    parentRunId: input.trustedJobId ? null : (input.trustedParentRunId ?? null),
    workspaceFolder: target.group.folder,
    runDelegatedAgent: async ({
      task,
      prompt,
      signal,
      onProcessStarted,
      onProgress,
      timeoutMs,
    }) => {
      const runAgent = context.deps.runAgent ?? spawnAgent;
      let latestResult: string | null = null;
      let processHandlePersisted: Promise<void> | null = null;
      const output = await runAgent(
        target.group,
        {
          prompt,
          appId: input.owner.appId,
          agentId: target.targetAgentId,
          chatJid: input.owner.conversationId,
          threadId: input.owner.threadId ?? undefined,
          workspaceFolder: target.group.folder,
          parentTaskId: task.id,
          parentRunId:
            input.trustedParentRunId ?? task.parentRunId ?? undefined,
          persona: target.group.agentConfig?.persona,
          thinking: target.group.agentConfig?.thinking,
          toolPolicyRules: target.toolPolicy.toolPolicyRules,
          runtimeAccess: target.toolPolicy.runtimeAccess,
          attachedSkillSourceIds: target.selectedSkillContext.ids,
          selectedSkillDisplays: target.selectedSkillContext.displays,
          attachedMcpSourceIds: target.attachedMcpSourceIds,
          semanticCapabilities: target.semanticCapabilities,
        },
        (proc) => {
          if (!proc.pid) return;
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
          processHandlePersisted.catch(() => proc.kill('SIGTERM'));
        },
        async (frame: AgentOutput) => {
          if (!frame.result) return;
          latestResult = frame.result;
          await onProgress?.(frame.result);
        },
        {
          timeoutMs: timeoutMs ?? DEFAULT_DELEGATED_AGENT_TIMEOUT_MS,
          signal,
          credentialBroker: await context.deps.getCredentialBroker?.(),
          skillRepository: context.deps.getSkillRepository?.(),
          skillArtifactStore: context.deps.getSkillArtifactStore?.(),
          skillContext: target.targetOwner,
          mcpServerRepository: context.deps.getMcpServerRepository?.(),
          capabilitySecretRepository:
            context.deps.getCapabilitySecretRepository?.(),
          mcpContext: target.targetOwner,
          mcpHostnameLookup: context.deps.mcpHostnameLookup,
          mcpDnsValidationCache: context.deps.getMcpDnsValidationCache?.(),
          publishRuntimeEvent: context.deps.publishRuntimeEvent,
          executionAdapter: context.deps.executionAdapter,
          executionAdapters: context.deps.executionAdapters,
          runnerSandboxProvider: context.deps.runnerSandboxProvider!,
          conversationRoutes: context.conversationBindings,
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
    },
  });
  const args = {
    objective: input.objective,
    context:
      toTrimmedString(input.payload.context, { maxLen: 20_000 }) ?? undefined,
    expectedOutput:
      toTrimmedString(input.payload.expectedOutput, { maxLen: 2_000 }) ??
      undefined,
    ...resolveDelegatedAgentTimeouts(
      input.payload,
      DEFAULT_DELEGATED_AGENT_TIMEOUT_MS,
    ),
  };
  if (!target.callableAgentEntry) {
    return backend.delegate_task({
      ...args,
      ...(input.requestedTargetAgentId
        ? { targetAgentId: input.requestedTargetAgentId }
        : {}),
    });
  }
  return dispatchCallableAgentTool({
    args,
    entry: target.callableAgentEntry,
    backend,
    revalidate: async (entry) => {
      const refreshed = await revalidateCallableAgentEntry(input, entry);
      if (!refreshed) return false;
      target = refreshed;
      return true;
    },
    narration: {
      sourceAgentFolder: context.sourceAgentFolder,
      isScheduledJob: Boolean(input.trustedJobId),
      deps: {
        sendMessage: context.deps.sendMessage,
        getFileArtifactStore: context.deps.getFileArtifactStore,
        warn: (details, message) => logger.warn(details, message),
      },
    },
  });
}

async function revalidateCallableAgentEntry(
  input: Parameters<typeof executeResolvedDelegation>[0],
  entry: CallableAgentToolManifestEntry,
): Promise<ResolvedDelegationTarget | undefined> {
  const refreshed = await resolveDelegatedAgentTarget({
    deps: input.context.deps,
    routes: input.context.conversationBindings,
    owner: input.owner,
    sourceAgentFolder: input.context.sourceAgentFolder,
    trustedProviderAccountId: input.trustedProviderAccountId,
    requestedProviderAccountId: input.context.data.providerAccountId,
    targetAgentId: entry.targetAgentId,
    callableAgentToolName: callableAgentToolName(entry),
  });
  if (!refreshed.ok) return undefined;
  const current = refreshed.callableAgentEntry;
  return current?.toolName === entry.toolName &&
    current.targetAgentId === entry.targetAgentId
    ? refreshed
    : undefined;
}
