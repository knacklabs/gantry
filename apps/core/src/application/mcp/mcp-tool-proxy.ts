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
import { projectCallerIdentityHeaders } from './mcp-caller-identity.js';
import { authorizedMcpServerIdsForAgent } from './mcp-authorized-servers.js';
import { CUSTOMER_IDENTITY_MISMATCH_MESSAGE } from '../../shared/user-visible-messages.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { flowLog } from '../../shared/flow-log.js';

const MCP_PROXY_TIMEOUT_MS = 60_000;
const MCP_PROXY_CLIENT_IDLE_MS = 0;

type CachedMcpClient = {
  client: Client;
  activeOperations: number;
  closeWhenIdle?: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
};

const clientCache = new Map<string, CachedMcpClient>();

export class McpToolProxy {
  constructor(
    private readonly mcpServers: McpServerRepository,
    private readonly options: {
      tools: ToolCatalogRepository;
      skills?: SkillCatalogRepository;
      credentialEnv?: Record<string, string>;
      callerIdentityJid?: string;
      // The real conversation JID (pre identity-override) — trace-only, so flow
      // logs attribute each MCP call to its conversation even when the signing
      // identity is remapped to a shared test number. Off in production.
      conversationJid?: string;
      callerIdentityJidForServer?: (serverName: string, jid: string) => string;
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
        releaseCachedClient(capability);
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
    const callerIdentityJid = this.callerIdentityJidForServer(input.serverName);
    // Flow trace: callerIdentityJid is the identity the request is signed with
    // (shows the test number when the dev override is active).
    flowLog(logger, 'mcp.request', {
      serverName: input.serverName,
      toolName: input.toolName,
      chatJid: this.options.conversationJid,
      callerIdentityJid,
      arguments: input.arguments ?? {},
    });
    let closeClientAfterCall = false;
    try {
      const result = await client.callTool(
        {
          name: input.toolName,
          arguments: input.arguments ?? {},
        },
        undefined,
        { timeout: MCP_PROXY_TIMEOUT_MS },
      );
      flowLog(logger, 'mcp.response', {
        serverName: input.serverName,
        toolName: input.toolName,
        chatJid: this.options.conversationJid,
        result,
      });
      return result;
    } catch (err) {
      flowLog(logger, 'mcp.error', {
        serverName: input.serverName,
        toolName: input.toolName,
        chatJid: this.options.conversationJid,
        error: err instanceof Error ? err.message : String(err),
      });
      closeClientAfterCall = true;
      throw err;
    } finally {
      releaseCachedClient(capability, { close: closeClientAfterCall });
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
    const capabilities = await new McpServerService(
      this.mcpServers,
      undefined,
      {
        lookupHostname: this.options.lookupHostname,
        dnsValidationCache: this.options.dnsValidationCache,
        auditMaterialization: false,
      },
    ).materializeForAgent({
      appId: input.appId,
      agentId: input.agentId,
      serverIds: serverIds as never,
      credentialEnv: this.options.credentialEnv ?? {},
    });
    return projectMcpProxyCallerIdentity({
      capabilities,
      callerIdentityJid: this.options.callerIdentityJid,
      callerIdentityJidForCapability: (capability) =>
        this.callerIdentityJidForServer(capability.name),
      credentialEnv: this.options.credentialEnv ?? {},
    });
  }

  private callerIdentityJidForServer(serverName: string): string | undefined {
    const jid = this.options.callerIdentityJid;
    if (!jid) return undefined;
    return this.options.callerIdentityJidForServer?.(serverName, jid) ?? jid;
  }

  private async connect(
    capability: MaterializedMcpCapability,
  ): Promise<Client> {
    const cacheKey = mcpClientCacheKey(capability);
    const cached = clientCache.get(cacheKey);
    if (cached) {
      if (cached.idleTimer) {
        clearTimeout(cached.idleTimer);
        cached.idleTimer = undefined;
      }
      cached.activeOperations += 1;
      return cached.client;
    }
    const client = new Client(
      { name: 'gantry-mcp-proxy', version: '1.0.0' },
      { capabilities: {} },
    );
    const transport = await this.createTransport(capability);
    await client.connect(transport, { timeout: MCP_PROXY_TIMEOUT_MS });
    clientCache.set(cacheKey, { client, activeOperations: 1 });
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

export function projectMcpProxyCallerIdentity(input: {
  capabilities: readonly MaterializedMcpCapability[];
  callerIdentityJid?: string;
  callerIdentityJidForCapability?: (
    capability: MaterializedMcpCapability,
  ) => string | undefined;
  credentialEnv: Record<string, string>;
}): MaterializedMcpCapability[] {
  if (
    !input.capabilities.some(
      (capability) =>
        capability.callerIdentity &&
        capability.callerIdentity.mode !== 'disabled',
    )
  ) {
    return [...input.capabilities];
  }
  const projected: MaterializedMcpCapability[] = [];
  for (const capability of input.capabilities) {
    if (
      !capability.callerIdentity ||
      capability.callerIdentity.mode === 'disabled'
    ) {
      projected.push(capability);
      continue;
    }
    const callerIdentityJid =
      input.callerIdentityJidForCapability?.(capability) ??
      input.callerIdentityJid;
    if (!callerIdentityJid) {
      throw new ApplicationError(
        'FORBIDDEN',
        CUSTOMER_IDENTITY_MISMATCH_MESSAGE,
        {
          details: [
            'MCP caller identity projection requires a source conversation JID.',
          ],
        },
      );
    }
    const projection = projectCallerIdentityHeaders({
      capabilities: [capability],
      chatJid: callerIdentityJid,
      credentialEnv: input.credentialEnv,
    });
    if (!projection.ok) {
      throw new ApplicationError('FORBIDDEN', projection.error, {
        details: [projection.internalError],
      });
    }
    projected.push(...projection.capabilities);
  }
  return projected;
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

function releaseCachedClient(
  capability: MaterializedMcpCapability,
  options: { close?: boolean } = {},
): void {
  const cacheKey = mcpClientCacheKey(capability);
  const cached = clientCache.get(cacheKey);
  if (!cached) return;
  if (cached.idleTimer) {
    clearTimeout(cached.idleTimer);
    cached.idleTimer = undefined;
  }
  cached.activeOperations = Math.max(0, cached.activeOperations - 1);
  cached.closeWhenIdle = cached.closeWhenIdle || options.close;
  if (cached.activeOperations > 0) return;
  if (cached.closeWhenIdle) {
    void closeCachedClient(capability);
    return;
  }
  if (MCP_PROXY_CLIENT_IDLE_MS <= 0) {
    void closeCachedClient(capability);
    return;
  }
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
  if (cached.idleTimer) clearTimeout(cached.idleTimer);
  try {
    await cached.client.close();
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        serverName: capability.name,
      },
      'MCP proxy client close failed',
    );
  }
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
