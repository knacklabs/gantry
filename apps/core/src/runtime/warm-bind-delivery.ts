import type {
  ConversationBindScope,
  WarmBindDelivery,
  WarmWorkerHandle,
} from '../application/agent-execution/warm-pool-capable.js';
import type { IpcConnection } from '../shared/ipc-connection.js';

const DEFAULT_BIND_READY_TIMEOUT_MS = 5_000;
const DEFAULT_BIND_READY_POLL_MS = 25;

export interface SocketWarmBindDeliveryOptions {
  bindReadyTimeoutMs?: number;
  pollIntervalMs?: number;
}

function bindPayload(scope: ConversationBindScope): Record<string, unknown> {
  return {
    chatJid: scope.chatJid,
    firstMessage: scope.firstMessage,
    ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
    ...(scope.memoryBlock ? { memoryBlock: scope.memoryBlock } : {}),
    ...(scope.guardrailPreface
      ? { guardrailPreface: scope.guardrailPreface }
      : {}),
    runHandle: scope.runHandle,
    ...(scope.threadId ? { threadId: scope.threadId } : {}),
    ...(scope.memoryUserId ? { memoryUserId: scope.memoryUserId } : {}),
    ipcAuthToken: scope.ipcAuthToken,
    ...(scope.browserIpcAuthToken
      ? { browserIpcAuthToken: scope.browserIpcAuthToken }
      : {}),
    memoryIpcAuthToken: scope.memoryIpcAuthToken,
    ipcResponseKeyId: scope.ipcResponseKeyId,
    ipcResponseVerifyKey: scope.ipcResponseVerifyKey,
  };
}

function findRunnerConnection(
  connections: readonly IpcConnection[],
  workerRunHandle: string,
): IpcConnection | undefined {
  return connections.find(
    (candidate) =>
      candidate.scope?.role === 'runner' &&
      candidate.scope?.runHandle === workerRunHandle,
  );
}

function rekeyRunnerConnection(
  runner: IpcConnection,
  scope: ConversationBindScope,
): void {
  const connectionScope = runner.scope;
  if (!connectionScope || connectionScope.role !== 'runner') return;
  connectionScope.runHandle = scope.runHandle;
  connectionScope.chatJid = scope.chatJid;
  connectionScope.threadId = scope.threadId ?? null;
  connectionScope.appId = scope.appId;
  connectionScope.agentId = scope.agentId;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForRunnerConnection(input: {
  connectionsForFolder: (folder: string) => IpcConnection[];
  folder: string;
  workerRunHandle: string;
  timeoutMs: number;
  pollIntervalMs: number;
}): Promise<IpcConnection | undefined> {
  const immediate = findRunnerConnection(
    input.connectionsForFolder(input.folder),
    input.workerRunHandle,
  );
  if (immediate || input.timeoutMs <= 0) return immediate;

  const deadline = Date.now() + input.timeoutMs;
  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    await delay(Math.min(input.pollIntervalMs, Math.max(1, remainingMs)));
    const runner = findRunnerConnection(
      input.connectionsForFolder(input.folder),
      input.workerRunHandle,
    );
    if (runner) return runner;
  }
  return undefined;
}

export function makeSocketWarmBindDelivery(
  connectionsForFolder: (folder: string) => IpcConnection[],
  options: SocketWarmBindDeliveryOptions = {},
): WarmBindDelivery {
  const bindReadyTimeoutMs =
    options.bindReadyTimeoutMs ?? DEFAULT_BIND_READY_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_BIND_READY_POLL_MS;

  return {
    async waitUntilReady(
      handle: WarmWorkerHandle,
      input: { groupFolder: string; timeoutMs?: number },
    ): Promise<boolean> {
      const workerRunHandle = handle.processName ?? handle.id;
      const runner = await waitForRunnerConnection({
        connectionsForFolder,
        folder: input.groupFolder,
        workerRunHandle,
        timeoutMs: input.timeoutMs ?? bindReadyTimeoutMs,
        pollIntervalMs,
      });
      return Boolean(runner);
    },
    async deliver(
      handle: WarmWorkerHandle,
      scope: ConversationBindScope,
    ): Promise<boolean> {
      const workerRunHandle = handle.processName ?? handle.id;
      const runner = await waitForRunnerConnection({
        connectionsForFolder,
        folder: scope.groupFolder,
        workerRunHandle,
        timeoutMs: bindReadyTimeoutMs,
        pollIntervalMs,
      });
      if (!runner) return false;
      runner.send({
        v: 1,
        type: 'push',
        channel: 'bind',
        id: `bind:${scope.runHandle}`,
        payload: bindPayload(scope),
      });
      rekeyRunnerConnection(runner, scope);
      return true;
    },
  };
}
