import type { ChildProcess } from 'node:child_process';

import {
  createCoreTaskLifecycleBackend,
  type CoreTaskLifecycleBackend,
} from '../../application/core-tools/task-lifecycle.js';
import type {
  AsyncTaskRecord,
  AsyncTaskRepository,
} from '../../domain/ports/async-tasks.js';
import { AsyncCommandTaskService } from '../../jobs/async-command-task-service.js';
import { nowIso } from '../../shared/time/datetime.js';
import type { InlineAgentLoopLaneInput } from '../../runtime/agent-inline.js';
import { spawnAgent } from '../../runtime/agent-spawn.js';
import type {
  AgentOutput,
  RunAgentOptions,
} from '../../runtime/agent-spawn-types.js';
import {
  localContinuationRunnerControlPort,
  RUNNER_CONTROL_PORT,
  type ContinuationRunnerControlPort,
} from '../../runtime/group-queue-types.js';
import { taskContinuationThreadId } from '../../runtime/continuation-input.js';

const DEFAULT_DELEGATED_AGENT_TIMEOUT_MS = 30 * 60_000;
const services = new WeakMap<AsyncTaskRepository, AsyncCommandTaskService>();
const activeProcesses = new Map<
  string,
  { process: ChildProcess; workspaceFolder: string }
>();

export function createInlineAgentTaskLifecycle(input: {
  laneInput: InlineAgentLoopLaneInput;
  repository?: AsyncTaskRepository;
  buildRunOptions(): Promise<RunAgentOptions>;
}): CoreTaskLifecycleBackend | undefined {
  const run = input.laneInput.input;
  if (!input.repository || !run.appId || !run.agentId) return undefined;
  const service = taskService(input.repository);
  const owner = {
    appId: run.appId,
    agentId: run.agentId,
    conversationId: run.chatJid,
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
            let latestResult: string | null = null;
            let processHandlePersisted: Promise<void> | undefined;
            const output = await spawnAgent(
              input.laneInput.group,
              {
                prompt: delegated.prompt,
                appId: owner.appId,
                agentId: owner.agentId,
                chatJid: owner.conversationId,
                threadId: owner.threadId ?? undefined,
                workspaceFolder: input.laneInput.group.folder,
                parentTaskId: delegated.task.id,
                persona: input.laneInput.group.agentConfig?.persona,
                thinking: input.laneInput.group.agentConfig?.thinking,
                toolPolicyRules: run.toolPolicyRules,
                runtimeAccess: run.runtimeAccess,
                attachedMcpSourceIds: run.attachedMcpSourceIds,
                semanticCapabilities: run.semanticCapabilities,
                yoloMode: run.yoloMode,
              },
              (process) => {
                activeProcesses.set(delegated.task.id, {
                  process,
                  workspaceFolder: input.laneInput.group.folder,
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
              async (output: AgentOutput) => {
                if (!output.result) return;
                latestResult = output.result;
                await delegated.onProgress?.(output.result);
              },
              {
                ...(await input.buildRunOptions()),
                timeoutMs:
                  delegated.timeoutMs ?? DEFAULT_DELEGATED_AGENT_TIMEOUT_MS,
                signal: delegated.signal,
              },
            ).finally(() => activeProcesses.delete(delegated.task.id));
            if (processHandlePersisted) await processHandlePersisted;
            if (output.status === 'error') {
              throw new Error(output.error ?? 'Delegated agent run failed.');
            }
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
