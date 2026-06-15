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
  isLoopbackAddress,
  type HostnameLookup,
} from '../../domain/network/public-address-policy.js';
import { evaluateEgressDenylist } from '../../shared/egress-policy.js';
import { createDnsPinnedMcpFetch } from '../../shared/dns-pinned-fetch.js';
import {
  mcpToolNameAllowedBySourceScope,
  mcpToolPatternCovers,
} from '../../shared/mcp-tool-scope.js';
import { ApplicationError } from '../common/application-error.js';
import { resolveAgentToolRuntimePolicy } from '../agents/agent-tool-runtime-rules.js';
import { reviewedExternalMcpToolNamesFromRuntimeAccess } from '../../shared/capability-runtime-access.js';
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

type ReviewedMaterializedMcpCapability = MaterializedMcpCapability & {
  reviewedToolNames: string[];
};

const clientCache = new Map<string, CachedMcpClient>();

export class McpToolProxy {
  constructor(
    private readonly mcpServers: McpServerRepository,
    private readonly options: {
      tools: ToolCatalogRepository;
      skills?: SkillCatalogRepository;
      credentialEnv?: Record<string, string>;
      liveToolRules?: readonly string[];
      lookupHostname?: HostnameLookup;
      dnsValidationCache?: RemoteMcpDnsValidationCache;
      egressDenylist?: readonly string[];
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
    const capabilities = await this.materializeSourceCapabilities(input);
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
            .filter((tool) =>
              isSourceInventoryToolAllowed(capability, tool.name),
            )
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
    const capabilities = await this.materializeReviewedCapabilities(input);
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
    if (!isReviewedMcpToolAllowed(capability, input.toolName)) {
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

  private async materializeSourceCapabilities(input: {
    appId: AppId;
    agentId: AgentId;
  }): Promise<ReviewedMaterializedMcpCapability[]> {
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
      credentialEnv: this.options.credentialEnv ?? {},
    });
    return capabilities.map((capability) => ({
      ...capability,
      reviewedToolNames: capability.allowedToolNames,
    }));
  }

  private async materializeReviewedCapabilities(input: {
    appId: AppId;
    agentId: AgentId;
  }): Promise<ReviewedMaterializedMcpCapability[]> {
    const policy = await resolveAgentToolRuntimePolicy({
      repository: this.options.tools,
      skillRepository: this.options.skills,
      appId: input.appId,
      agentId: input.agentId,
      errorSubject: 'Configured agent tool',
    });
    const reviewedToolNames = [
      ...new Set([
        ...reviewedExternalMcpToolNamesFromRuntimeAccess(policy.runtimeAccess),
        ...exactExternalMcpToolNames(this.options.liveToolRules),
      ]),
    ];
    const serverIds = await authorizedMcpServerIdsForAgent({
      mcpServers: this.mcpServers,
      tools: this.options.tools,
      skills: this.options.skills,
      appId: input.appId,
      agentId: input.agentId,
      allowedTools: reviewedToolNames,
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
    return capabilities.map((capability) => ({
      ...capability,
      reviewedToolNames: reviewedToolNames.filter((toolName) =>
        reviewedToolNameAllowedBySourceScope(capability, toolName),
      ),
    }));
  }

  private async connect(
    capability: MaterializedMcpCapability,
  ): Promise<Client> {
    this.assertNetworkAllowedForCapability(capability);
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
      if (!isLocalLoopbackHttpMcpUrl(new URL(config.url))) {
        await assertRemoteMcpDestinationPublic(
          { transport: config.type, url: config.url, headers: config.headers },
          this.options.lookupHostname,
          { cache: this.options.dnsValidationCache },
        );
      }
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

  private assertNetworkAllowedForCapability(
    capability: MaterializedMcpCapability,
  ): void {
    const config = capability.config;
    if (config.type !== 'http' && config.type !== 'sse') return;
    assertMcpNetworkHostAllowed({
      serverName: capability.name,
      url: config.url,
      networkHosts: capability.networkHosts,
      denylist: this.options.egressDenylist ?? [],
    });
  }
}

/**
 * Enforce third-party MCP server network authority at connection establishment,
 * reusing the shared egress denylist policy. The global denylist always wins;
 * declared hosts are review/audit metadata, not an operational allowlist.
 */
export function assertMcpNetworkHostAllowed(input: {
  serverName: string;
  url: string;
  networkHosts: readonly string[];
  denylist: readonly string[];
}): void {
  const parsed = new URL(input.url);
  const hostname = parsed.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.+$/, '');
  const hostLabel = `${hostname}:${parsed.port || defaultPortForProtocol(parsed.protocol)}`;
  const deny = evaluateEgressDenylist({
    settings: { denylist: [...input.denylist] },
    host: hostname,
  });
  if (deny) {
    throw new ApplicationError(
      'FORBIDDEN',
      `Network access denied: MCP server ${input.serverName} host ${hostLabel} matches the egress denylist.`,
    );
  }
}

function isReviewedMcpToolAllowed(
  capability: ReviewedMaterializedMcpCapability,
  toolName: string,
): boolean {
  const fullToolName = toolName.startsWith('mcp__')
    ? toolName
    : `mcp__${capability.name}__${toolName}`;
  return capability.reviewedToolNames.includes(fullToolName);
}

function exactExternalMcpToolNames(
  rules: readonly string[] | undefined,
): string[] {
  const out = new Set<string>();
  for (const rule of rules ?? []) {
    const trimmed = rule.trim();
    if (/^mcp__(?!gantry__)[A-Za-z0-9_-]+__[A-Za-z0-9_.-]+$/.test(trimmed)) {
      out.add(trimmed);
    }
  }
  return [...out];
}

function reviewedToolNameAllowedBySourceScope(
  capability: MaterializedMcpCapability,
  fullToolName: string,
): boolean {
  return mcpToolNameAllowedBySourceScope({
    serverName: capability.name,
    fullToolName,
    allowedToolPatterns: capability.allowedToolPatterns,
  });
}

function isSourceInventoryToolAllowed(
  capability: MaterializedMcpCapability,
  toolName: string,
): boolean {
  const patterns =
    capability.allowedToolPatterns.length > 0
      ? capability.allowedToolPatterns
      : capability.allowedToolNames.map((name) =>
          name.replace(`mcp__${capability.name}__`, ''),
        );
  if (patterns.length === 0) return true;
  return patterns.some((pattern) => mcpToolPatternCovers(pattern, toolName));
}

function defaultPortForProtocol(protocol: string): string {
  return protocol === 'http:' ? '80' : '443';
}

function isLocalLoopbackHttpMcpUrl(url: URL): boolean {
  return url.protocol === 'http:' && isLoopbackAddress(url.hostname);
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
  const remoteFetch = createDnsPinnedMcpFetch({
    lookupHostname: input.lookupHostname,
  });
  // Remote MCP transports use a DNS-pinned fetch: the hostname is resolved once,
  // validated public, and the connection is pinned to that address with TLS SNI
  // bound to the hostname. This replaces the earlier IP-literal-only fail-closed
  // path so hostname-based remote MCP servers work without a rebinding window.
  return ((
    url: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => {
    const target = new URL(
      typeof url === 'string' || url instanceof URL ? url : url.url,
    );
    if (isLocalLoopbackHttpMcpUrl(target)) {
      return fetch(url, init);
    }
    return remoteFetch(url, init);
  }) as typeof fetch;
}
