import { loadMcpTools } from '@langchain/mcp-adapters';
import {
  tool as createLangChainTool,
  type StructuredToolInterface,
} from '@langchain/core/tools';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import {
  assertMcpNetworkHostAllowed,
  createGuardedMcpFetch,
} from '../../../../application/mcp/mcp-tool-proxy-network.js';
import type { MaterializedMcpCapability } from '../../../../application/mcp/mcp-server-service.js';
import { mcpToolPatternCovers } from '../../../../shared/mcp-tool-scope.js';
import type { ProviderInlineAgentLoopLane } from '../../inline-lane-dispatcher.js';
import type { InlineToolActivity } from '../../inline-lane-tool-activity.js';
import { runnableToolInvocationId } from '../runner/tool-invocation-id.js';

const REMOTE_MCP_STARTUP_CONCURRENCY = 4;

type LaneInput = Parameters<ProviderInlineAgentLoopLane>[0];

interface RemoteMcpStartupInput {
  authorizeThirdPartyMcpTool: LaneInput['coreTools']['authorizeThirdPartyMcpTool'];
  recordThirdPartyMcpToolActivity: LaneInput['coreTools']['recordThirdPartyMcpToolActivity'];
  egressDenylist: readonly string[];
  lookupHostname?: Parameters<
    typeof createGuardedMcpFetch
  >[0]['lookupHostname'];
  signal: AbortSignal;
  toolActivity: InlineToolActivity;
}

interface RemoteMcpStartupResult {
  tools: StructuredToolInterface[];
  close(): Promise<void>;
}

interface ConnectedRemoteMcpServer {
  index: number;
  client: Client;
  tools: StructuredToolInterface[];
}

export async function connectRemoteMcpTools(
  servers: readonly MaterializedMcpCapability[],
  input: RemoteMcpStartupInput,
): Promise<RemoteMcpStartupResult> {
  if (
    !servers.some(
      (server) => server.config.type === 'http' || server.config.type === 'sse',
    )
  ) {
    return { tools: [], close: () => Promise.resolve() };
  }
  const guardedFetch = createGuardedMcpFetch({
    lookupHostname: input.lookupHostname,
  });
  const startupAbort = new AbortController();
  const clients: Client[] = [];
  const failureClosedClients = new WeakSet<Client>();
  const failureClosePromises: Promise<void>[] = [];
  const results: Array<ConnectedRemoteMcpServer | undefined> = [];
  let nextIndex = 0;
  let failure: { error: unknown } | undefined;
  const closeClientAfterFailure = (client: Client) => {
    if (failureClosedClients.has(client)) return;
    failureClosedClients.add(client);
    failureClosePromises.push(client.close().catch(() => undefined));
  };
  const stopStartup = (error: unknown) => {
    failure ??= { error };
    if (!startupAbort.signal.aborted) startupAbort.abort(error);
    for (const client of clients) closeClientAfterFailure(client);
  };
  const registerClient = (client: Client) => {
    clients.push(client);
    if (failure) closeClientAfterFailure(client);
  };
  const throwIfStartupStopped = () => {
    if (failure) throw failure.error;
    input.signal.throwIfAborted();
  };
  const onInputAbort = () => {
    stopStartup(input.signal.reason ?? new Error('Remote MCP startup aborted'));
  };
  if (input.signal.aborted) onInputAbort();
  else input.signal.addEventListener('abort', onInputAbort, { once: true });
  const workerCount = Math.min(REMOTE_MCP_STARTUP_CONCURRENCY, servers.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (!failure) {
      const index = nextIndex;
      nextIndex += 1;
      const server = servers[index];
      if (!server) return;
      try {
        throwIfStartupStopped();
        const result = await connectOneRemoteMcpServer({
          index,
          server,
          input,
          guardedFetch,
          startupSignal: startupAbort.signal,
          registerClient,
          throwIfStartupStopped,
        });
        if (result) results[index] = result;
      } catch (error) {
        stopStartup(error);
        return;
      }
    }
  });
  try {
    await Promise.all(workers);
  } finally {
    input.signal.removeEventListener('abort', onInputAbort);
  }
  if (failure) {
    await Promise.all(failureClosePromises);
    throw failure.error;
  }
  const tools = results.flatMap((result) => result?.tools ?? []);
  let closed = false;
  return {
    tools,
    close: async () => {
      if (closed) return;
      closed = true;
      await Promise.all(clients.map((client) => client.close()));
    },
  };
}

async function connectOneRemoteMcpServer(input: {
  index: number;
  server: MaterializedMcpCapability;
  input: RemoteMcpStartupInput;
  guardedFetch: ReturnType<typeof createGuardedMcpFetch>;
  startupSignal: AbortSignal;
  registerClient(client: Client): void;
  throwIfStartupStopped(): void;
}): Promise<ConnectedRemoteMcpServer | undefined> {
  const { server } = input;
  if (server.config.type !== 'http' && server.config.type !== 'sse')
    return undefined;
  input.throwIfStartupStopped();
  assertMcpNetworkHostAllowed({
    serverName: server.name,
    url: server.config.url,
    denylist: input.input.egressDenylist,
  });
  const client = new Client({
    name: `gantry-inline-${server.name}`,
    version: '1.0.0',
  });
  input.registerClient(client);
  input.throwIfStartupStopped();
  const headers = server.config.headers;
  const requestInit = {
    ...(headers ? { headers } : {}),
    signal: combineAbortSignals(input.input.signal, input.startupSignal),
  };
  const transport =
    server.config.type === 'sse'
      ? new SSEClientTransport(new URL(server.config.url), {
          fetch: input.guardedFetch as never,
          requestInit,
        })
      : new StreamableHTTPClientTransport(new URL(server.config.url), {
          fetch: input.guardedFetch as never,
          requestInit,
        });
  await settleOnAbort(client.connect(transport), input.startupSignal);
  input.throwIfStartupStopped();
  const loaded = await loadMcpTools(server.name, client, {
    prefixToolNameWithServerName: false,
  });
  input.throwIfStartupStopped();
  const tools: StructuredToolInterface[] = [];
  for (const remoteTool of loaded) {
    if (
      !server.allowedToolPatterns.some((pattern) =>
        mcpToolPatternCovers(pattern, remoteTool.name),
      )
    ) {
      continue;
    }
    const toolName = `mcp__${server.name}__${remoteTool.name}`;
    tools.push(
      createLangChainTool(
        async (args, config) => {
          const invocationId = runnableToolInvocationId(config);
          const authorization = await input.input.authorizeThirdPartyMcpTool(
            toolName,
            args,
            { signal: config?.signal ?? input.input.signal },
          );
          if (!authorization.allowed) {
            await input.input.toolActivity.terminal(
              toolName,
              'failure',
              invocationId,
            );
            return `Permission denied: ${authorization.reason ?? 'request denied'}`;
          }
          return input.input.toolActivity.run(
            toolName,
            async () => {
              const startedAt = Date.now();
              await input.input.recordThirdPartyMcpToolActivity({
                serverName: server.name,
                toolName: remoteTool.name,
                toolInput: args,
                outcome: 'attempt',
                latencyMs: 0,
              });
              try {
                const result = await remoteTool.invoke(
                  args,
                  config?.signal ? { signal: config.signal } : undefined,
                );
                const activity = {
                  serverName: server.name,
                  toolName: remoteTool.name,
                  toolInput: args,
                  outcome: 'success',
                  latencyMs: Date.now() - startedAt,
                  result,
                } as const;
                await input.input.recordThirdPartyMcpToolActivity(activity);
                return typeof result === 'string'
                  ? result
                  : JSON.stringify(result);
              } catch (error) {
                await input.input.recordThirdPartyMcpToolActivity({
                  serverName: server.name,
                  toolName: remoteTool.name,
                  toolInput: args,
                  outcome: 'failure',
                  latencyMs: Date.now() - startedAt,
                  error,
                });
                throw error;
              }
            },
            invocationId,
          );
        },
        {
          name: toolName,
          description: remoteTool.description,
          schema: remoteTool.schema as never,
        },
      ),
    );
  }
  return { index: input.index, client, tools };
}

function combineAbortSignals(
  signal: AbortSignal,
  startupSignal: AbortSignal,
): AbortSignal {
  const controller = new AbortController();
  const abort = (source: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(source.reason);
  };
  if (signal.aborted) abort(signal);
  if (startupSignal.aborted) abort(startupSignal);
  if (!controller.signal.aborted) {
    signal.addEventListener('abort', () => abort(signal), { once: true });
    startupSignal.addEventListener('abort', () => abort(startupSignal), {
      once: true,
    });
  }
  return controller.signal;
}

function settleOnAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
