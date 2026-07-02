import {
  ASYNC_TASK_STALE_AFTER_MS,
  AsyncCommandTaskService,
} from '../../jobs/async-command-task-service.js';
import { failUnrecoverableQueuedAsyncTasks } from '../../jobs/async-command-queue-recovery.js';
import {
  DEFAULT_ASYNC_COMMAND_TIMEOUT_MS,
  DEFAULT_ASYNC_RESOURCE_LIMITS,
  buildAsyncCommandEnv,
  runSandboxedAsyncCommand,
} from '../../jobs/async-command-sandbox-runner.js';
import {
  closeEgressGateway,
  ensureEgressGateway,
} from '../../runtime/egress-gateway.js';
import type { Logger } from '../../infrastructure/logging/logger.js';
import type { IpcDeps } from '../../runtime/ipc.js';

interface AsyncTaskRecoveryDeps {
  getAsyncTaskRepository?: IpcDeps['getAsyncTaskRepository'];
  getEgressSettings?: IpcDeps['getEgressSettings'];
  publishRuntimeEvent?: IpcDeps['publishRuntimeEvent'];
  runnerSandboxProvider?: IpcDeps['runnerSandboxProvider'];
  logger: Pick<Logger, 'warn'>;
}

export async function recoverStaleAsyncCommandTasks(
  appId: string,
  deps: AsyncTaskRecoveryDeps,
  options: { failUnrecoverableQueued?: boolean } = {},
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
    const recovered = await service.recoverStaleTasks({
      appId,
      staleAfterMs: ASYNC_TASK_STALE_AFTER_MS,
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
    if (options.failUnrecoverableQueued === true) {
      const failedQueued = await failUnrecoverableQueuedAsyncTasks({
        repository,
        appId,
      });
      if (failedQueued > 0) {
        deps.logger.warn(
          { failedQueued },
          'Failed unrecoverable queued async tasks',
        );
      }
    }
  } catch (err) {
    deps.logger.warn({ err }, 'Failed to recover stale async command tasks');
  }
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
