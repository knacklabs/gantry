import type { ChildProcess } from 'node:child_process';

import {
  createCoreTaskLifecycleBackend,
  type CoreTaskLifecycleBackend,
} from '../../application/core-tools/task-lifecycle.js';
import { agentIdForFolder } from '../../domain/agent/agent-folder-id.js';
import type {
  AsyncTaskRecord,
  AsyncTaskRepository,
} from '../../domain/ports/async-tasks.js';
import type { ConversationRoute } from '../../domain/types.js';
import type { RuntimeAgentSessionRepository } from '../../domain/repositories/ops-repo.js';
import type { ExecutionProviderId } from '../../domain/sessions/sessions.js';
import { AsyncCommandTaskService } from '../../jobs/async-command-task-service.js';
import { nowIso } from '../../shared/time/datetime.js';
import type { InlineAgentLoopLaneInput } from '../../runtime/agent-inline.js';
import { spawnAgent } from '../../runtime/agent-spawn.js';
import type {
  AgentInput,
  AgentOutput,
  RunAgentOptions,
} from '../../runtime/agent-spawn-types.js';
import {
  localContinuationRunnerControlPort,
  RUNNER_CONTROL_PORT,
  type ContinuationRunnerControlPort,
} from '../../runtime/group-queue-types.js';
import { taskContinuationThreadId } from '../../runtime/continuation-input.js';
import { resolveConversationRoute } from './runtime-app-routes.js';

const DEFAULT_DELEGATED_AGENT_TIMEOUT_MS = 30 * 60_000;
const services = new WeakMap<AsyncTaskRepository, AsyncCommandTaskService>();
const activeProcesses = new Map<
  string,
  { process: ChildProcess; workspaceFolder: string }
>();

type DelegatedRunRepository = Pick<
  RuntimeAgentSessionRepository,
  'getAgentTurnContext' | 'createSessionAgentRun' | 'completeSessionAgentRun'
>;

type DelegatedRunAccess = Pick<
  AgentInput,
  | 'toolPolicyRules'
  | 'runtimeAccess'
  | 'attachedSkillSourceIds'
  | 'selectedSkillDisplays'
  | 'attachedMcpSourceIds'
  | 'semanticCapabilities'
>;

export function createInlineAgentTaskLifecycle(input: {
  laneInput: InlineAgentLoopLaneInput;
  repository?: AsyncTaskRepository;
  runRepository?: DelegatedRunRepository;
  getConversationRoutes(): Record<string, ConversationRoute>;
  resolveExecutionProviderId(
    route: Pick<ConversationRoute, 'agentConfig' | 'folder'>,
    chatJid: string,
  ): Promise<ExecutionProviderId>;
  resolveRunAccess(agentId: string): Promise<DelegatedRunAccess>;
  buildRunOptions(agentId: string): Promise<RunAgentOptions>;
}): CoreTaskLifecycleBackend | undefined {
  const run = input.laneInput.input;
  if (!input.repository || !run.appId || !run.agentId) return undefined;
  const service = taskService(input.repository);
  const owner = {
    appId: run.appId,
    agentId: run.agentId,
    conversationId: run.chatJid,
    providerAccountId: input.laneInput.group.providerAccountId ?? null,
    threadId: run.threadId ?? null,
  };
  return createCoreTaskLifecycleBackend({
    service,
    owner,
    parentTaskId: run.parentTaskId,
    parentRunId: run.jobId ? null : run.runId,
    workspaceFolder: input.laneInput.group.folder,
    ...(run.parentTaskId
      ? {}
      : {
          runDelegatedAgent: async (delegated) => {
            const targetGroup = delegated.targetAgentId
              ? resolveConversationRoute(
                  input.getConversationRoutes(),
                  owner.conversationId,
                  owner.threadId,
                  delegated.targetAgentId,
                  input.laneInput.group.providerAccountId,
                )
              : input.laneInput.group;
            if (!targetGroup) {
              throw new Error(
                `Target agent is not bound to this conversation: ${delegated.targetAgentId}`,
              );
            }
            const targetAgentId =
              targetGroup.agentId ?? agentIdForFolder(targetGroup.folder);
            const sameAgent =
              !delegated.targetAgentId || targetAgentId === owner.agentId;
            const executionProviderId = await input.resolveExecutionProviderId(
              targetGroup,
              owner.conversationId,
            );
            const turnContext =
              await input.runRepository?.getAgentTurnContext?.({
                appId: owner.appId,
                agentFolder: targetGroup.folder,
                executionProviderId,
                conversationJid: owner.conversationId,
                providerAccountId: targetGroup.providerAccountId,
                threadId: owner.threadId,
                conversationKind: targetGroup.conversationKind,
                hydrateMemory: false,
              });
            if (turnContext?.agentId && turnContext.agentId !== targetAgentId) {
              throw new Error(
                `Target agent session mismatch: bound ${targetAgentId}, resolved ${turnContext.agentId}.`,
              );
            }
            // AgentDelegation authorizes a bound-agent handoff; the child then
            // runs only with the target agent's selected authority.
            const runAccess = sameAgent
              ? {
                  toolPolicyRules: run.toolPolicyRules,
                  runtimeAccess: run.runtimeAccess,
                  attachedSkillSourceIds: run.attachedSkillSourceIds,
                  selectedSkillDisplays: run.selectedSkillDisplays,
                  attachedMcpSourceIds: run.attachedMcpSourceIds,
                  semanticCapabilities: run.semanticCapabilities,
                }
              : await input.resolveRunAccess(targetAgentId);
            const childRunId = turnContext?.agentSessionId
              ? await input.runRepository?.createSessionAgentRun?.({
                  agentSessionId: turnContext.agentSessionId,
                  executionProviderId,
                  cause: 'manual',
                })
              : undefined;
            let latestResult: string | null = null;
            let processHandlePersisted: Promise<void> | undefined;
            let output: AgentOutput;
            try {
              output = await spawnAgent(
                targetGroup,
                {
                  prompt: delegated.prompt,
                  appId: owner.appId,
                  agentId: targetAgentId,
                  chatJid: owner.conversationId,
                  threadId: owner.threadId ?? undefined,
                  workspaceFolder: targetGroup.folder,
                  parentTaskId: delegated.task.id,
                  ...(childRunId ? { runId: childRunId } : {}),
                  persona: targetGroup.agentConfig?.persona,
                  thinking: targetGroup.agentConfig?.thinking,
                  ...runAccess,
                  ...(sameAgent ? { yoloMode: run.yoloMode } : {}),
                },
                (process) => {
                  activeProcesses.set(delegated.task.id, {
                    process,
                    workspaceFolder: targetGroup.folder,
                  });
                  if (!process.pid) return;
                  processHandlePersisted = Promise.resolve(
                    delegated.onProcessStarted?.({
                      pid: process.pid,
                      processGroupId: process.pid,
                      detached: true,
                      platform: globalThis.process.platform,
                      ownerPid: globalThis.process.pid,
                      startedAt: nowIso(),
                    }),
                  );
                  processHandlePersisted.catch(() => process.kill('SIGTERM'));
                },
                async (agentOutput: AgentOutput) => {
                  if (!agentOutput.result) return;
                  latestResult = agentOutput.result;
                  await delegated.onProgress?.(agentOutput.result);
                },
                {
                  ...(await input.buildRunOptions(targetAgentId)),
                  timeoutMs:
                    delegated.timeoutMs ?? DEFAULT_DELEGATED_AGENT_TIMEOUT_MS,
                  signal: delegated.signal,
                },
              ).finally(() => activeProcesses.delete(delegated.task.id));
              if (processHandlePersisted) await processHandlePersisted;
            } catch (error) {
              await completeDelegatedRun(input.runRepository, childRunId, {
                status: delegated.signal.aborted ? 'canceled' : 'failed',
                errorSummary:
                  error instanceof Error ? error.message : String(error),
              });
              throw error;
            }
            if (output.status === 'error') {
              await completeDelegatedRun(input.runRepository, childRunId, {
                status: delegated.signal.aborted ? 'canceled' : 'failed',
                errorSummary: output.error ?? 'Delegated agent run failed.',
              });
              throw new Error(output.error ?? 'Delegated agent run failed.');
            }
            await completeDelegatedRun(input.runRepository, childRunId, {
              status: 'completed',
              resultSummary: output.result ?? latestResult,
            });
            return {
              outputSummary:
                output.result ?? latestResult ?? 'delegated task completed',
            };
          },
        }),
    deliverTaskMessage: (task, message) =>
      deliverInlineTaskMessage(task, message),
  });
}

async function completeDelegatedRun(
  repository: DelegatedRunRepository | undefined,
  runId: string | undefined,
  result: {
    status: 'completed' | 'failed' | 'canceled';
    resultSummary?: string | null;
    errorSummary?: string | null;
  },
): Promise<void> {
  if (!runId) return;
  await repository?.completeSessionAgentRun?.({ runId, ...result });
}

function taskService(repository: AsyncTaskRepository): AsyncCommandTaskService {
  const existing = services.get(repository);
  if (existing) return existing;
  const service = new AsyncCommandTaskService(repository, {
    run: async () => {
      throw new Error('Inline core tools do not expose async commands.');
    },
  });
  services.set(repository, service);
  return service;
}

async function deliverInlineTaskMessage(
  task: AsyncTaskRecord,
  message: string,
): Promise<void> {
  const active = activeProcesses.get(task.id);
  if (!active) throw new Error('Delegated task runner is unavailable.');
  const control =
    (
      active.process as ChildProcess & {
        [RUNNER_CONTROL_PORT]?: ContinuationRunnerControlPort;
      }
    )[RUNNER_CONTROL_PORT] ?? localContinuationRunnerControlPort;
  await control.writeContinuationInput({
    workspaceFolder: active.workspaceFolder,
    text: message,
    sequence: Date.now(),
    threadId: taskContinuationThreadId(task.threadId, task.id),
  });
}
