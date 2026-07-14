import {
  ASYNC_TASK_STALE_AFTER_MS,
  AsyncCommandTaskService,
} from '../../jobs/async-command-task-service.js';
import {
  DEFAULT_ASYNC_COMMAND_TIMEOUT_MS,
  DEFAULT_ASYNC_RESOURCE_LIMITS,
  buildAsyncCommandEnv,
  runSandboxedAsyncCommand,
} from '../../jobs/async-command-sandbox-runner.js';
import { recoverQueuedAsyncMcpTasks } from '../../jobs/async-mcp-tool-task.js';
import {
  closeEgressGateway,
  ensureEgressGateway,
} from '../../runtime/egress-gateway.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { IpcDeps } from '../../runtime/ipc.js';
import { spawnAgent } from '../../runtime/agent-spawn.js';
import type { AgentOutput } from '../../runtime/agent-spawn-types.js';
import { RUNTIME_EVENT_TYPES } from '../../domain/events/runtime-event-types.js';
import type { RuntimeEventPublishInput } from '../../domain/events/events.js';
import {
  resolveTurnSelectedMcpServerIds,
  resolveTurnSelectedSkillContext,
  resolveTurnSemanticCapabilities,
  resolveTurnToolPolicy,
} from '../../runtime/group-run-context.js';
import {
  releaseCompactionLockFromTask,
  SESSION_COMPACTION_TIMEOUT_MS,
} from '../../runtime/group-session-command-state.js';
import { McpToolProxy } from '../../application/mcp/mcp-tool-proxy.js';
import { resolveMcpCredentialEnvForAgent } from '../../application/capability-secrets/mcp-secret-projection.js';
import type { AsyncTaskRecord } from '../../domain/ports/async-tasks.js';
import type { RuntimeAgentSessionRepository } from '../../domain/repositories/ops-repo.js';
import { agentIdForFolder } from '../../domain/agent/agent-folder-id.js';
import { resolveConversationRoute } from './runtime-app-routes.js';

interface AsyncTaskRecoveryDeps extends Partial<
  Pick<
    IpcDeps,
    | 'conversationRoutes'
    | 'executionAdapter'
    | 'executionAdapters'
    | 'getAsyncTaskRepository'
    | 'getCapabilitySecretRepository'
    | 'getCredentialBroker'
    | 'getEgressSettings'
    | 'getMcpDnsValidationCache'
    | 'getMcpServerRepository'
    | 'getSkillArtifactStore'
    | 'getSkillRepository'
    | 'getToolRepository'
    | 'mcpHostnameLookup'
    | 'publishRuntimeEvent'
    | 'runAgent'
    | 'runnerSandboxProvider'
  >
> {
  logger: Pick<Logger, 'warn'>;
  opsRepository?: RuntimeAgentSessionRepository;
}

export async function recoverStaleAsyncCommandTasks(
  appId: string,
  deps: AsyncTaskRecoveryDeps,
): Promise<void> {
  const repository = deps.getAsyncTaskRepository?.();
  if (!repository) return;
  const runnerSandboxProvider = deps.runnerSandboxProvider;
  const service =
    runnerSandboxProvider?.enforcing === true
      ? new AsyncCommandTaskService(
          repository,
          {
            run: async (input) =>
              runSandboxedAsyncCommand(runnerSandboxProvider, {
                ...input,
                cwd: input.cwd ?? process.cwd(),
                env: buildAsyncCommandEnv(),
                timeoutMs: DEFAULT_ASYNC_COMMAND_TIMEOUT_MS,
                outputMaxBytes: 4_000,
                protectedReadPaths: [...(input.protectedReadPaths ?? [])],
                protectedWritePaths: [...(input.protectedWritePaths ?? [])],
                allowedNetworkHosts: [...(input.allowedNetworkHosts ?? [])],
                egressProxyUrl: input.egressProxyUrl,
                resourceLimits:
                  input.resourceLimits ?? DEFAULT_ASYNC_RESOURCE_LIMITS,
              }),
          },
          {
            createRecoveredDelegatedAgentRun:
              createRecoveredDelegatedAgentRun(deps),
            prepareRun: async ({ task, allowedNetworkHosts }) => {
              const gateway = await ensureEgressGateway({
                key: `${task.appId}:${task.agentId}:${task.id}`,
                settings: deps.getEgressSettings?.() ?? { denylist: [] },
                principal: {
                  appId: task.appId,
                  agentId: task.agentId,
                  ...(task.conversationId
                    ? { conversationId: task.conversationId }
                    : {}),
                  ...(task.threadId ? { threadId: task.threadId } : {}),
                  ...(task.parentRunId ? { runId: task.parentRunId } : {}),
                  ...(task.parentJobId ? { jobId: task.parentJobId } : {}),
                },
                ...(allowedNetworkHosts && allowedNetworkHosts.length > 0
                  ? { allowedNetworkHosts }
                  : {}),
                ...(deps.publishRuntimeEvent
                  ? { publishRuntimeEvent: deps.publishRuntimeEvent }
                  : {}),
              });
              return {
                egressProxyUrl: gateway.proxyUrl,
                cleanup: () => closeEgressGateway(gateway),
              };
            },
          },
        )
      : new AsyncCommandTaskService(repository, {
          run: async () => ({
            errorSummary: 'async command runner unavailable',
          }),
        });
  try {
    const timedOutCompactions = await recoverStaleSessionCompactionTasks(
      appId,
      deps,
    );
    if (timedOutCompactions > 0) {
      deps.logger.warn(
        { timedOutCompactions },
        'Recovered stale session compaction tasks',
      );
    }
    const recovered = await service.recoverStaleTasks({
      appId,
      staleAfterMs: ASYNC_TASK_STALE_AFTER_MS,
      excludeKinds: ['session_compaction'],
    });
    if (recovered > 0) {
      deps.logger.warn({ recovered }, 'Recovered stale async command tasks');
    }
    if (runnerSandboxProvider?.enforcing === true) {
      const queued = await service.recoverQueuedTasks({ appId });
      if (queued > 0) {
        deps.logger.warn({ queued }, 'Recovered queued async command tasks');
      }
    }
    const queuedMcp = await recoverQueuedAsyncMcpTasks({
      repository,
      appId,
      createProxy: (task) => createRecoveredMcpProxy(deps, task),
    });
    if (queuedMcp > 0) {
      deps.logger.warn({ queuedMcp }, 'Recovered queued async MCP tasks');
    }
  } catch (err) {
    deps.logger.warn({ err }, 'Failed to recover stale async command tasks');
  }
}

export async function recoverStaleSessionCompactionTasks(
  appId: string,
  deps: AsyncTaskRecoveryDeps,
): Promise<number> {
  const repository = deps.getAsyncTaskRepository?.();
  if (!repository) return 0;
  const staleBefore = Date.now() - SESSION_COMPACTION_TIMEOUT_MS;
  const tasks = await repository.listTasks({
    appId,
    kind: 'session_compaction',
    statuses: ['queued', 'running'],
    order: 'oldest_first',
    limit: 200,
  });
  let recovered = 0;
  for (const task of tasks) {
    const activityAt = Date.parse(
      task.heartbeatAt ?? task.updatedAt ?? task.createdAt,
    );
    if (Number.isFinite(activityAt) && activityAt >= staleBefore) continue;
    const now = new Date().toISOString();
    const errorSummary = 'Session compaction exceeded the 10 minute timeout.';
    const terminal = await repository.transitionTask({
      taskId: task.id,
      leaseToken: task.leaseToken,
      fencingVersion: task.fencingVersion,
      status: 'timed_out',
      now,
      terminalAt: now,
      errorSummary,
      expectedUpdatedAt: task.updatedAt,
    });
    if (!terminal) continue;
    recovered += 1;
    if (deps.opsRepository) {
      await releaseCompactionLockFromTask(
        deps.opsRepository,
        stringValue(terminal.privateCorrelationJson.provider) ?? '',
        terminal,
      );
    }
    await publishSessionCompactionTimeoutEvent(
      deps.publishRuntimeEvent,
      terminal,
      errorSummary,
    ).catch((err) =>
      deps.logger.warn(
        { err, taskId: task.id },
        'Failed to publish session compaction timeout event',
      ),
    );
  }
  return recovered;
}

async function publishSessionCompactionTimeoutEvent(
  publishRuntimeEvent:
    | ((event: RuntimeEventPublishInput) => Promise<unknown> | unknown)
    | undefined,
  task: AsyncTaskRecord,
  errorSummary: string,
): Promise<void> {
  if (!publishRuntimeEvent) return;
  await publishRuntimeEvent({
    appId: task.appId as never,
    agentId: task.agentId as never,
    ...(stringValue(task.privateCorrelationJson.agentSessionId)
      ? {
          sessionId: stringValue(
            task.privateCorrelationJson.agentSessionId,
          ) as never,
        }
      : {}),
    ...(task.conversationId
      ? { conversationId: task.conversationId as never }
      : {}),
    ...(task.threadId ? { threadId: task.threadId as never } : {}),
    eventType: RUNTIME_EVENT_TYPES.SESSION_COMPACTION_TIMEOUT,
    actor: 'runtime',
    responseMode: 'none',
    payload: {
      state: 'timeout',
      taskId: task.id,
      ...(stringValue(task.privateCorrelationJson.provider)
        ? { provider: stringValue(task.privateCorrelationJson.provider) }
        : {}),
      errorSummary,
    },
  });
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

const ASYNC_TASK_RECOVERY_INTERVAL_MS = 30_000;
let activeAsyncTaskRecoveryLoop: NodeJS.Timeout | undefined;

export function startAsyncTaskRecoveryLoop(
  appId: string,
  deps: AsyncTaskRecoveryDeps,
): void {
  stopAsyncTaskRecoveryLoop();
  activeAsyncTaskRecoveryLoop = setInterval(() => {
    void recoverStaleAsyncCommandTasks(appId, deps);
  }, ASYNC_TASK_RECOVERY_INTERVAL_MS);
  activeAsyncTaskRecoveryLoop.unref?.();
}

export function stopAsyncTaskRecoveryLoop(): void {
  if (!activeAsyncTaskRecoveryLoop) return;
  clearInterval(activeAsyncTaskRecoveryLoop);
  activeAsyncTaskRecoveryLoop = undefined;
}

function createRecoveredDelegatedAgentRun(
  deps: AsyncTaskRecoveryDeps,
): NonNullable<
  ConstructorParameters<typeof AsyncCommandTaskService>[2]
>['createRecoveredDelegatedAgentRun'] {
  return (_task, taskInput) => async (runInput) => {
    const conversationId = runInput.task.conversationId ?? '';
    const routes = deps.conversationRoutes?.() ?? {};
    const recoveryAgentId = taskInput.targetAgentId ?? runInput.task.agentId;
    const group = resolveConversationRoute(
      routes,
      conversationId,
      runInput.task.threadId,
      recoveryAgentId,
      taskInput.providerAccountId,
    );
    if (!group) {
      throw new Error('Delegated task conversation is unavailable.');
    }
    const routedAgentId = group.agentId ?? agentIdForFolder(group.folder);
    if (routedAgentId !== recoveryAgentId) {
      throw new Error(
        `Delegated task route mismatch: expected ${recoveryAgentId}, resolved ${routedAgentId}.`,
      );
    }
    const scopedTaskOwner = {
      appId: runInput.task.appId,
      agentId: taskInput.targetAgentId ? routedAgentId : runInput.task.agentId,
    };
    const [toolPolicy, selectedSkillContext, semanticCapabilities] =
      await Promise.all([
        resolveTurnToolPolicy(deps, scopedTaskOwner),
        resolveTurnSelectedSkillContext(deps, scopedTaskOwner),
        resolveTurnSemanticCapabilities(deps, scopedTaskOwner),
      ]);
    const attachedMcpSourceIds = await resolveTurnSelectedMcpServerIds(
      deps,
      scopedTaskOwner,
      toolPolicy.toolPolicyRules,
    );
    const runAgent = deps.runAgent ?? spawnAgent;
    let latestResult: string | null = null;
    let processHandlePersisted: Promise<void> | null = null;
    const output = await runAgent(
      group,
      {
        prompt: runInput.prompt,
        appId: runInput.task.appId,
        agentId: scopedTaskOwner.agentId,
        chatJid: conversationId,
        threadId: runInput.task.threadId ?? undefined,
        workspaceFolder: group.folder,
        parentTaskId: runInput.task.id,
        persona: group.agentConfig?.persona,
        thinking: group.agentConfig?.thinking,
        toolPolicyRules: toolPolicy.toolPolicyRules,
        runtimeAccess: toolPolicy.runtimeAccess,
        attachedSkillSourceIds: selectedSkillContext.ids,
        selectedSkillDisplays: selectedSkillContext.displays,
        attachedMcpSourceIds,
        semanticCapabilities,
      },
      (proc) => {
        if (!proc.pid) return;
        processHandlePersisted = Promise.resolve(
          runInput.onProcessStarted?.({
            pid: proc.pid,
            processGroupId: proc.pid,
            detached: true,
            platform: process.platform,
            ownerPid: process.pid,
            startedAt: new Date().toISOString(),
          }),
        );
        processHandlePersisted.catch(() => proc.kill('SIGTERM'));
      },
      async (output: AgentOutput) => {
        if (output.result) {
          latestResult = output.result;
          await runInput.onProgress?.(output.result);
        }
      },
      {
        signal: runInput.signal,
        credentialBroker: await deps.getCredentialBroker?.(),
        skillRepository: deps.getSkillRepository?.(),
        skillArtifactStore: deps.getSkillArtifactStore?.(),
        skillContext: scopedTaskOwner,
        mcpServerRepository: deps.getMcpServerRepository?.(),
        capabilitySecretRepository: deps.getCapabilitySecretRepository?.(),
        mcpContext: scopedTaskOwner,
        mcpHostnameLookup: deps.mcpHostnameLookup,
        mcpDnsValidationCache: deps.getMcpDnsValidationCache?.(),
        publishRuntimeEvent: deps.publishRuntimeEvent,
        executionAdapter: deps.executionAdapter,
        executionAdapters: deps.executionAdapters,
        runnerSandboxProvider: deps.runnerSandboxProvider!,
        asyncTaskRepositoryAvailable: Boolean(deps.getAsyncTaskRepository?.()),
      },
    );
    if (processHandlePersisted) await processHandlePersisted;
    if (output.status === 'error') {
      throw new Error(output.error ?? 'Delegated agent run failed.');
    }
    return {
      outputSummary:
        output.result ?? latestResult ?? 'delegated task completed',
    };
  };
}

async function createRecoveredMcpProxy(
  deps: AsyncTaskRecoveryDeps,
  task: AsyncTaskRecord,
): Promise<McpToolProxy> {
  const mcpServers = deps.getMcpServerRepository?.();
  const tools = deps.getToolRepository?.();
  if (!mcpServers || !tools) {
    throw new Error('MCP repositories are unavailable.');
  }
  const secrets = deps.getCapabilitySecretRepository?.();
  const credentialEnv = secrets
    ? await resolveMcpCredentialEnvForAgent({
        appId: task.appId as never,
        agentId: task.agentId as never,
        mcpServers,
        secrets,
      })
    : {};
  return new McpToolProxy(mcpServers, {
    tools,
    skills: deps.getSkillRepository?.(),
    credentialEnv,
    lookupHostname: deps.mcpHostnameLookup,
    dnsValidationCache: deps.getMcpDnsValidationCache?.(),
    egressDenylist: deps.getEgressSettings?.().denylist,
    publishRuntimeEvent: deps.publishRuntimeEvent,
    runId: task.parentRunId ?? undefined,
  });
}
