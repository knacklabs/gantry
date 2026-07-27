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
  const guardedFetch = createGuardedMcpFetch({
    lookupHostname: input.lookupHostname,
  });
  const clients: Client[] = [];
  const results: Array<ConnectedRemoteMcpServer | undefined> = [];
  let nextIndex = 0;
  let failure: { error: unknown } | undefined;
  const workerCount = Math.min(REMOTE_MCP_STARTUP_CONCURRENCY, servers.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (!failure) {
      const index = nextIndex;
      nextIndex += 1;
      const server = servers[index];
      if (!server) return;
      try {
        const result = await connectOneRemoteMcpServer({
          index,
          server,
          input,
          guardedFetch,
          connectedClients: clients,
        });
        if (result) results[index] = result;
      } catch (error) {
        failure ??= { error };
        return;
      }
    }
  });
  await Promise.all(workers);
  if (failure) {
    await Promise.all(
      clients.map((client) => client.close().catch(() => undefined)),
    );
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
  connectedClients: Client[];
}): Promise<ConnectedRemoteMcpServer | undefined> {
  const { server } = input;
  if (server.config.type !== 'http' && server.config.type !== 'sse')
    return undefined;
  input.input.signal.throwIfAborted();
  assertMcpNetworkHostAllowed({
    serverName: server.name,
    url: server.config.url,
    denylist: input.input.egressDenylist,
  });
  const client = new Client({
    name: `gantry-inline-${server.name}`,
    version: '1.0.0',
  });
  const headers = server.config.headers;
  const transport =
    server.config.type === 'sse'
      ? new SSEClientTransport(new URL(server.config.url), {
          fetch: input.guardedFetch as never,
          requestInit: headers ? { headers } : undefined,
        })
      : new StreamableHTTPClientTransport(new URL(server.config.url), {
          fetch: input.guardedFetch as never,
          requestInit: headers ? { headers } : undefined,
        });
  await client.connect(transport);
  input.connectedClients.push(client);
  const loaded = await loadMcpTools(server.name, client, {
    prefixToolNameWithServerName: false,
  });
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
          const authorization = await input.input.authorizeThirdPartyMcpTool(
            toolName,
            args,
            { signal: config?.signal ?? input.input.signal },
          );
          if (!authorization.allowed) {
            return `Permission denied: ${authorization.reason ?? 'request denied'}`;
          }
          return input.input.toolActivity.run(toolName, async () => {
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
          });
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
