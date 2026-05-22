import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type {
  McpServerRepository,
  SkillCatalogRepository,
  ToolCatalogRepository,
} from '../../domain/ports/repositories.js';
import {
  isIpAddress,
  type HostnameLookup,
} from '../../domain/network/public-address-policy.js';
import { ApplicationError } from '../common/application-error.js';
import {
  RemoteMcpDnsValidationCache,
  assertRemoteMcpDestinationPublic,
} from './mcp-server-policy.js';
import {
  McpServerService,
  type MaterializedMcpCapability,
} from './mcp-server-service.js';
import { authorizedMcpServerIdsForAgent } from './mcp-authorized-servers.js';

const MCP_PROXY_TIMEOUT_MS = 60_000;
const MCP_PROXY_CLIENT_IDLE_MS = 120_000;

type CachedMcpClient = {
  client: Client;
  idleTimer: ReturnType<typeof setTimeout>;
};

const clientCache = new Map<string, CachedMcpClient>();

export class McpToolProxy {
  constructor(
    private readonly mcpServers: McpServerRepository,
    private readonly options: {
      tools: ToolCatalogRepository;
      skills?: SkillCatalogRepository;
      credentialEnv?: Record<string, string>;
      lookupHostname?: HostnameLookup;
      dnsValidationCache?: RemoteMcpDnsValidationCache;
    },
  ) {}

  async listTools(input: {
    appId: AppId;
    agentId: AgentId;
    serverName?: string;
  }): Promise<{
    servers: Array<{
      name: string;
      tools: Array<{
        name: string;
        description?: string;
        inputSchema?: unknown;
      }>;
    }>;
  }> {
    const capabilities = await this.materializeCapabilities(input);
    const servers = [];
    for (const capability of capabilities) {
      if (input.serverName && capability.name !== input.serverName) continue;
      const client = await this.connect(capability);
      try {
        const tools = await client.listTools(
          {},
          { timeout: MCP_PROXY_TIMEOUT_MS },
        );
        servers.push({
          name: capability.name,
          tools: tools.tools
            .filter((tool) => isToolAllowed(capability, tool.name))
            .map((tool) => ({
              name: tool.name,
              ...(tool.description ? { description: tool.description } : {}),
              ...(tool.inputSchema ? { inputSchema: tool.inputSchema } : {}),
            })),
        });
      } finally {
        scheduleClientIdleClose(capability);
      }
    }
    return { servers };
  }

  async callTool(input: {
    appId: AppId;
    agentId: AgentId;
    serverName: string;
    toolName: string;
    arguments?: Record<string, unknown>;
  }): Promise<unknown> {
    const capabilities = await this.materializeCapabilities(input);
    const capability = capabilities.find(
      (candidate) => candidate.name === input.serverName,
    );
    if (!capability) {
      throw new ApplicationError(
        'NOT_FOUND',
        `MCP server is not approved for this agent: ${input.serverName}`,
      );
    }
    const allowedTool = `mcp__${capability.name}__${input.toolName}`;
    if (!isToolAllowed(capability, input.toolName)) {
      throw new ApplicationError(
        'FORBIDDEN',
        `MCP tool is not approved for this agent: ${allowedTool}`,
      );
    }
    const client = await this.connect(capability);
    try {
      return await client.callTool(
        {
          name: input.toolName,
          arguments: input.arguments ?? {},
        },
        undefined,
        { timeout: MCP_PROXY_TIMEOUT_MS },
      );
    } catch (err) {
      await closeCachedClient(capability);
      throw err;
    } finally {
      scheduleClientIdleClose(capability);
    }
  }

  private async materializeCapabilities(input: {
    appId: AppId;
    agentId: AgentId;
  }): Promise<MaterializedMcpCapability[]> {
    const serverIds = await authorizedMcpServerIdsForAgent({
      mcpServers: this.mcpServers,
      tools: this.options.tools,
      skills: this.options.skills,
      appId: input.appId,
      agentId: input.agentId,
    });
    return await new McpServerService(this.mcpServers, undefined, {
      lookupHostname: this.options.lookupHostname,
      dnsValidationCache: this.options.dnsValidationCache,
      auditMaterialization: false,
    }).materializeForAgent({
      appId: input.appId,
      agentId: input.agentId,
      serverIds: serverIds as never,
      credentialEnv: this.options.credentialEnv ?? {},
    });
  }

  private async connect(
    capability: MaterializedMcpCapability,
  ): Promise<Client> {
    const cacheKey = mcpClientCacheKey(capability);
    const cached = clientCache.get(cacheKey);
    if (cached) {
      clearTimeout(cached.idleTimer);
      return cached.client;
    }
    const client = new Client(
      { name: 'gantry-mcp-proxy', version: '1.0.0' },
      { capabilities: {} },
    );
    const transport = await this.createTransport(capability);
    await client.connect(transport, { timeout: MCP_PROXY_TIMEOUT_MS });
    clientCache.set(cacheKey, {
      client,
      idleTimer: setTimeout(() => {
        void closeCachedClient(capability);
      }, MCP_PROXY_CLIENT_IDLE_MS),
    });
    return client;
  }

  private async createTransport(
    capability: MaterializedMcpCapability,
  ): Promise<Transport> {
    const config = capability.config;
    if (config.type === 'http' || config.type === 'sse') {
      await assertRemoteMcpDestinationPublic(
        { transport: config.type, url: config.url, headers: config.headers },
        this.options.lookupHostname,
        { cache: this.options.dnsValidationCache },
      );
      const fetch = createGuardedMcpFetch({
        lookupHostname: this.options.lookupHostname,
        dnsValidationCache: this.options.dnsValidationCache,
      });
      const requestInit: RequestInit = {
        redirect: 'error',
        ...(config.headers ? { headers: config.headers } : {}),
      };
      return config.type === 'http'
        ? new StreamableHTTPClientTransport(new URL(config.url), {
            requestInit,
            fetch,
          })
        : new SSEClientTransport(new URL(config.url), {
            requestInit,
            fetch,
          });
    }
    throw new ApplicationError(
      'FORBIDDEN',
      'stdio_template MCP servers are approved durable capabilities, but current-session proxy execution is disabled until sandboxed stdio execution is implemented.',
    );
  }
}

function isToolAllowed(
  capability: MaterializedMcpCapability,
  toolName: string,
): boolean {
  const patterns =
    capability.allowedToolPatterns.length > 0
      ? capability.allowedToolPatterns
      : capability.allowedToolNames.map((name) =>
          name.replace(`mcp__${capability.name}__`, ''),
        );
  return patterns.some((pattern) => toolPatternCovers(pattern, toolName));
}

function toolPatternCovers(pattern: string, candidate: string): boolean {
  return (
    pattern === candidate ||
    (pattern.endsWith('*') && candidate.startsWith(pattern.slice(0, -1)))
  );
}

function mcpClientCacheKey(capability: MaterializedMcpCapability): string {
  return `${capability.name}:${JSON.stringify(capability.config)}`;
}

function scheduleClientIdleClose(capability: MaterializedMcpCapability): void {
  const cacheKey = mcpClientCacheKey(capability);
  const cached = clientCache.get(cacheKey);
  if (!cached) return;
  clearTimeout(cached.idleTimer);
  cached.idleTimer = setTimeout(() => {
    void closeCachedClient(capability);
  }, MCP_PROXY_CLIENT_IDLE_MS);
}

async function closeCachedClient(
  capability: MaterializedMcpCapability,
): Promise<void> {
  const cacheKey = mcpClientCacheKey(capability);
  const cached = clientCache.get(cacheKey);
  if (!cached) return;
  clientCache.delete(cacheKey);
  clearTimeout(cached.idleTimer);
  await cached.client.close();
}

export function createGuardedMcpFetch(input: {
  lookupHostname?: HostnameLookup;
  dnsValidationCache?: RemoteMcpDnsValidationCache;
}): typeof fetch {
  return async (url, init) => {
    const resolvedUrl =
      typeof url === 'string'
        ? new URL(url)
        : url instanceof URL
          ? url
          : new URL(url.url);
    if (!isIpAddress(resolvedUrl.hostname)) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        'Remote MCP hostname fetches require DNS-pinned transport.',
      );
    }
    await assertRemoteMcpDestinationPublic(
      { transport: 'http', url: resolvedUrl.toString() },
      input.lookupHostname,
      { cache: input.dnsValidationCache },
    );
    return fetch(url, {
      ...init,
      redirect: 'error',
    });
  };
}
