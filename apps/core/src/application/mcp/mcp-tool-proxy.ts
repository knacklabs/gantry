import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type { RuntimeEventPublishInput } from '../../domain/events/events.js';
import type {
  McpServerRepository,
  SkillCatalogRepository,
  ToolCatalogRepository,
} from '../../domain/ports/repositories.js';
import type { HostnameLookup } from '../../domain/network/public-address-policy.js';
import { ApplicationError } from '../common/application-error.js';
import { RemoteMcpDnsValidationCache } from './mcp-server-policy.js';
import {
  isReviewedMcpToolAllowed,
  isSourceInventoryToolAllowed,
  type ReviewedMaterializedMcpCapability,
} from './mcp-tool-authorization.js';
import { resolveReviewedMcpTool } from './mcp-reviewed-tool-resolution.js';
import {
  materializeReviewedMcpCapabilities,
  materializeSourceMcpCapabilities,
} from './mcp-tool-proxy-capabilities.js';
import {
  cacheMcpInventory,
  compareMcpToolSearchResults,
  type CachedMcpInventory,
  type DetailedMcpTool,
  listedMcpTool,
  type ListedMcpTool,
  type McpToolListDiagnostics,
  mcpToolMatchesQuery,
  normalizeMcpListCursor,
  normalizeMcpListLimit,
  readCachedMcpInventory,
  readCachedMcpToolDetail,
} from './mcp-tool-inventory.js';
import {
  classifyMcpToolAuditError,
  type McpToolAuditResultClass,
  summarizeMcpToolArguments,
  summarizeMcpToolError,
} from './mcp-tool-audit.js';
import { prepareMcpToolResultValidation } from './mcp-tool-result-validation.js';
import { fetchMcpToolListPages } from './mcp-tool-list-fetch.js';
import {
  fetchAndCacheMcpToolDetail,
  resolveMcpToolOutputSchema,
} from './mcp-tool-detail-fetch.js';
import { boundMcpToolResultForReturn } from './mcp-tool-output-bounds.js';
import {
  closeCachedMcpClient,
  releaseMcpClient,
  retainMcpClient,
  scheduleMcpClientIdleClose,
} from './mcp-tool-proxy-client-cache.js';
import { publishMcpToolActivity } from './mcp-tool-proxy-audit.js';
import {
  connectMcpToolProxyClient,
  type McpToolProxyClientAdapters,
} from './mcp-tool-proxy-connection.js';

export { clearMcpToolProxyInventoryCache } from './mcp-tool-inventory.js';
export {
  assertMcpNetworkHostAllowed,
  createGuardedMcpFetch,
} from './mcp-tool-proxy-network.js';

const MCP_PROXY_TIMEOUT_MS = 60_000;
const MCP_INVENTORY_SEARCH_CONCURRENCY = 4;
type McpClientTransport = Parameters<Client['connect']>[0];
export const MCP_TOOL_PROXY_CLIENT_ADAPTERS: McpToolProxyClientAdapters<
  McpClientTransport,
  Client
> = {
  createClient: (onToolsChanged) =>
    new Client(
      { name: 'gantry-mcp-proxy', version: '1.0.0' },
      {
        capabilities: {},
        listChanged: {
          tools: {
            autoRefresh: false,
            debounceMs: 250,
            onChanged: onToolsChanged,
          },
        },
      },
    ),
  createHttpTransport: (url, options) =>
    new StreamableHTTPClientTransport(url, options),
  createSseTransport: (url, options) => new SSEClientTransport(url, options),
};
interface McpToolCallInput {
  appId: AppId;
  agentId: AgentId;
  conversationId?: string;
  threadId?: string;
  serverName: string;
  toolName: string;
  arguments?: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type McpToolSearchMatch = ListedMcpTool & {
  coveredByReviewedCapability: boolean;
  reviewedCapabilityIds?: string[];
};

export interface McpToolSearchResult {
  query: string;
  limit: number;
  total: number;
  matches: McpToolSearchMatch[];
  deferredServers?: string[];
}

export class McpToolProxy {
  constructor(
    private readonly mcpServers: McpServerRepository,
    private readonly options: {
      tools: ToolCatalogRepository;
      skills?: SkillCatalogRepository;
      credentialEnv?: Record<string, string>;
      liveToolRules?: readonly string[];
      sourceServerIds?: readonly string[];
      lookupHostname?: HostnameLookup;
      dnsValidationCache?: RemoteMcpDnsValidationCache;
      egressDenylist?: readonly string[];
      publishRuntimeEvent?: (
        event: RuntimeEventPublishInput,
      ) => Promise<unknown> | unknown;
      runId?: string;
      runHandle?: string;
    },
  ) {}

  async listTools(input: {
    appId: AppId;
    agentId: AgentId;
    conversationId?: string;
    threadId?: string;
    serverName?: string;
    query?: string;
    limit?: number;
    cursor?: string;
  }): Promise<{
    servers: Array<{
      name: string;
      tools: ListedMcpTool[];
    }>;
    serverName?: string;
    query?: string;
    limit: number;
    cursor?: string;
    nextCursor?: string;
    total: number;
    deferredServers?: string[];
    diagnostics: McpToolListDiagnostics;
  }> {
    const capabilities = await this.materializeSourceCapabilities(input);
    const matchingCapabilities = capabilities.filter(
      (capability) => !input.serverName || capability.name === input.serverName,
    );
    const shouldFetchUncached =
      Boolean(input.serverName) ||
      Boolean(input.query?.trim()) ||
      matchingCapabilities.length <= 1;
    const connectedServerNames: string[] = [];
    const allowedToolCountByServer = new Map<string, number>();
    const diagnostics: McpToolListDiagnostics = {
      connectedServerCount: matchingCapabilities.length,
      deferredServerCount: 0,
      inventoryCacheHits: 0,
      inventoryCacheMisses: 0,
      liveListCalls: 0,
      liveListMs: 0,
      remoteListPageCount: 0,
      remoteListTruncated: false,
      discoveredToolCount: 0,
      loadedToolCount: 0,
      selectedToolCount: 0,
      returnedToolCount: 0,
    };
    const listedTools: Array<{
      serverName: string;
      tool: ListedMcpTool;
    }> = [];
    const inventories = new Map<string, CachedMcpInventory>();
    const uncachedCapabilities: ReviewedMaterializedMcpCapability[] = [];
    const deferredServers: string[] = [];
    for (const capability of matchingCapabilities) {
      connectedServerNames.push(capability.name);
      const inventory = readCachedMcpInventory(input, capability);
      if (inventory) {
        diagnostics.inventoryCacheHits += 1;
        inventories.set(capability.name, inventory);
      } else {
        diagnostics.inventoryCacheMisses += 1;
        if (shouldFetchUncached) {
          uncachedCapabilities.push(capability);
        }
      }
    }
    diagnostics.liveListCalls = uncachedCapabilities.length;
    for (
      let offset = 0;
      offset < uncachedCapabilities.length;
      offset += MCP_INVENTORY_SEARCH_CONCURRENCY
    ) {
      const fetched = await Promise.all(
        uncachedCapabilities
          .slice(offset, offset + MCP_INVENTORY_SEARCH_CONCURRENCY)
          .map(async (capability) => {
            const controller = new AbortController();
            const fetchStartedAt = Date.now();
            let timeout: ReturnType<typeof setTimeout> | undefined;
            try {
              const inventory = await Promise.race([
                this.fetchAndCacheInventory(
                  input,
                  capability,
                  controller.signal,
                ),
                new Promise<never>((_, reject) => {
                  timeout = setTimeout(() => {
                    controller.abort();
                    reject(new Error('MCP inventory fetch timed out.'));
                  }, MCP_PROXY_TIMEOUT_MS);
                  timeout.unref?.();
                }),
              ]);
              return { capability, inventory };
            } catch {
              return { capability };
            } finally {
              if (timeout) clearTimeout(timeout);
              diagnostics.liveListMs += Math.max(
                0,
                Date.now() - fetchStartedAt,
              );
            }
          }),
      );
      for (const result of fetched) {
        if (result.inventory) {
          inventories.set(result.capability.name, result.inventory);
        }
      }
    }
    for (const capability of matchingCapabilities) {
      const inventory = inventories.get(capability.name);
      if (!inventory) {
        deferredServers.push(capability.name);
        continue;
      }
      allowedToolCountByServer.set(capability.name, inventory.totalAllowed);
      diagnostics.remoteListPageCount += inventory.remoteListPageCount;
      diagnostics.remoteListTruncated ||= inventory.remoteListTruncated;
      diagnostics.discoveredToolCount += inventory.totalAllowed;
      diagnostics.loadedToolCount += inventory.tools.length;
      for (const tool of inventory.tools) {
        listedTools.push({ serverName: capability.name, tool });
      }
    }
    const query = input.query?.trim();
    const filteredTools = listedTools
      .filter((item) => mcpToolMatchesQuery(item, query))
      .sort((left, right) => compareMcpToolSearchResults(left, right, query));
    const limit = normalizeMcpListLimit(input.limit);
    const cursor = normalizeMcpListCursor(input.cursor);
    const page = filteredTools.slice(cursor, cursor + limit);
    diagnostics.selectedToolCount = filteredTools.length;
    diagnostics.returnedToolCount = page.length;
    diagnostics.deferredServerCount = deferredServers.length;
    const serversByName = new Map<
      string,
      {
        name: string;
        tools: ListedMcpTool[];
      }
    >();
    for (const item of page) {
      const server = serversByName.get(item.serverName) ?? {
        name: item.serverName,
        tools: [],
      };
      server.tools.push(item.tool);
      serversByName.set(item.serverName, server);
    }
    if (!query) {
      for (const serverName of connectedServerNames) {
        if (
          (allowedToolCountByServer.get(serverName) ?? 0) === 0 &&
          !serversByName.has(serverName)
        ) {
          serversByName.set(serverName, { name: serverName, tools: [] });
        }
      }
    }
    const nextOffset =
      cursor + limit < filteredTools.length
        ? String(cursor + limit)
        : undefined;
    return {
      servers: [...serversByName.values()],
      ...(input.serverName ? { serverName: input.serverName } : {}),
      ...(query ? { query } : {}),
      limit,
      ...(cursor > 0 ? { cursor: String(cursor) } : {}),
      ...(nextOffset ? { nextCursor: nextOffset } : {}),
      total: filteredTools.length,
      ...(deferredServers.length > 0 ? { deferredServers } : {}),
      diagnostics,
    };
  }

  // FTS-style ranked search over the live source inventory. The interface is
  // semantic-ready: a future semantic backend swaps the scorer behind the same
  // {query, limit} → typed-matches contract. Matches are marked with whether a
  // selected reviewed capability covers them so the caller knows callable vs
  // inventory-only; mcp_call_tool still rechecks at call time.
  async searchTools(input: {
    appId: AppId;
    agentId: AgentId;
    conversationId?: string;
    threadId?: string;
    query: string;
    limit?: number;
  }): Promise<McpToolSearchResult> {
    const [listed, reviewedCapabilities] = await Promise.all([
      this.listTools({
        appId: input.appId,
        agentId: input.agentId,
        conversationId: input.conversationId,
        threadId: input.threadId,
        query: input.query,
        limit: input.limit,
      }),
      this.materializeReviewedCapabilities(input),
    ]);
    const reviewedByServer = new Map(
      reviewedCapabilities.map((capability) => [capability.name, capability]),
    );
    const matches = listed.servers
      .flatMap((server) =>
        server.tools.map((tool) => {
          const reviewed = reviewedByServer.get(server.name);
          const covered = reviewed
            ? isReviewedMcpToolAllowed(reviewed, tool.name)
            : false;
          return {
            ...tool,
            coveredByReviewedCapability: covered,
            ...(covered && reviewed?.reviewedCapabilityIds?.length
              ? { reviewedCapabilityIds: reviewed.reviewedCapabilityIds }
              : {}),
          };
        }),
      )
      .sort((left, right) =>
        compareMcpToolSearchResults(
          { serverName: left.serverName, tool: left },
          { serverName: right.serverName, tool: right },
          input.query,
        ),
      );
    return {
      query: input.query,
      limit: listed.limit,
      total: listed.total,
      matches,
      ...(listed.deferredServers?.length
        ? { deferredServers: listed.deferredServers }
        : {}),
    };
  }

  async describeTool(input: {
    appId: AppId;
    agentId: AgentId;
    conversationId?: string;
    threadId?: string;
    serverName: string;
    toolName: string;
  }): Promise<DetailedMcpTool> {
    const capabilities = await this.materializeSourceCapabilities(input);
    const capability = capabilities.find(
      (candidate) => candidate.name === input.serverName,
    );
    if (!capability) {
      throw new ApplicationError(
        'NOT_FOUND',
        `MCP server is not approved for this agent: ${input.serverName}`,
      );
    }
    if (!isSourceInventoryToolAllowed(capability, input.toolName)) {
      throw new ApplicationError(
        'NOT_FOUND',
        `MCP tool is not available from source inventory: ${input.serverName}.${input.toolName}`,
      );
    }
    const cached = readCachedMcpToolDetail(input, capability, input.toolName);
    if (cached) {
      return {
        ...cached.tool,
        diagnostics: {
          detailCacheHits: 1,
          detailCacheMisses: 0,
          liveDetailCalls: 0,
          liveDetailMs: 0,
          metadataBytes: cached.metadataBytes,
        },
      };
    }
    const client = await connectMcpToolProxyClient(
      capability,
      this.options,
      MCP_TOOL_PROXY_CLIENT_ADAPTERS,
    );
    const detailStartedAt = Date.now();
    try {
      const detail = await fetchAndCacheMcpToolDetail({
        request: input,
        capability,
        client,
        timeoutMs: MCP_PROXY_TIMEOUT_MS,
      });
      return {
        ...detail.tool,
        diagnostics: {
          detailCacheHits: 0,
          detailCacheMisses: 1,
          liveDetailCalls: 1,
          liveDetailMs: Math.max(0, Date.now() - detailStartedAt),
          metadataBytes: detail.metadataBytes,
        },
      };
    } finally {
      scheduleMcpClientIdleClose(capability);
    }
  }

  async callTool(input: McpToolCallInput): Promise<unknown> {
    const startedAt = Date.now();
    const timeoutMs = input.timeoutMs ?? MCP_PROXY_TIMEOUT_MS;
    const argumentSummary = summarizeMcpToolArguments(input.arguments ?? {});
    await this.publishMcpToolActivity({
      input,
      resultClass: 'attempt',
      latencyMs: 0,
      argumentSummary,
    });
    let finalized = false;
    let selectedToolRule: string | undefined;
    let selectedCapability:
      | Pick<
          ReviewedMaterializedMcpCapability,
          'name' | 'serverId' | 'bindingId' | 'sourceRevision'
        >
      | undefined;
    const finalize = async (
      resultClass: McpToolAuditResultClass,
      extra: Record<string, unknown> = {},
    ) => {
      await this.publishMcpToolActivity({
        input,
        resultClass,
        latencyMs: Date.now() - startedAt,
        argumentSummary,
        selectedToolRule,
        selectedCapability,
        ...extra,
      });
      finalized = true;
    };
    let toolReturned = false;
    try {
      const reviewed = await this.resolveReviewedTool(input, finalize);
      const { capability } = reviewed;
      selectedToolRule = reviewed.selectedToolRule;
      selectedCapability = reviewed.selectedCapability;
      const client = await connectMcpToolProxyClient(
        capability,
        this.options,
        MCP_TOOL_PROXY_CLIENT_ADAPTERS,
      );
      retainMcpClient(capability);
      try {
        const outputSchema = await resolveMcpToolOutputSchema({
          request: input,
          capability,
          client,
          timeoutMs: MCP_PROXY_TIMEOUT_MS,
          signal: input.signal,
        });
        const resultValidation = prepareMcpToolResultValidation({
          serverName: input.serverName,
          toolName: input.toolName,
          ...(outputSchema !== undefined ? { outputSchema } : {}),
        });
        const result = await client.callTool(
          {
            name: input.toolName,
            arguments: input.arguments ?? {},
          },
          undefined,
          {
            timeout: timeoutMs,
            ...(input.signal ? { signal: input.signal } : {}),
          },
        );
        toolReturned = true;
        const validationAudit = resultValidation.validate(result);
        try {
          await finalize(
            validationAudit.toolResultError ? 'failure' : 'success',
            validationAudit,
          );
        } catch {
          // A remote MCP tool already returned. Do not make completed external
          // side effects look retryable because the post-call audit append failed.
        }
        return boundMcpToolResultForReturn(result);
      } catch (err) {
        await closeCachedMcpClient(capability);
        throw err;
      } finally {
        releaseMcpClient(capability);
      }
    } catch (err) {
      if (!finalized) {
        const finalizeFailure = () =>
          finalize(classifyMcpToolAuditError(err), {
            error: summarizeMcpToolError(err),
          });
        if (toolReturned) {
          try {
            await finalizeFailure();
          } catch {
            // Preserve the real post-call failure instead of replacing it with
            // an audit-store failure after a remote MCP tool already returned.
          }
        } else {
          await finalizeFailure();
        }
      }
      throw err;
    }
  }

  async assertToolAllowed(input: McpToolCallInput): Promise<void> {
    const argumentSummary = summarizeMcpToolArguments(input.arguments ?? {});
    const startedAt = Date.now();
    await this.resolveReviewedTool(input, (resultClass, extra = {}) =>
      this.publishMcpToolActivity({
        input,
        resultClass,
        latencyMs: Date.now() - startedAt,
        argumentSummary,
        ...extra,
      }),
    );
  }

  private async fetchAndCacheInventory(
    input: {
      appId: AppId;
      agentId: AgentId;
    },
    capability: ReviewedMaterializedMcpCapability,
    signal?: AbortSignal,
  ): Promise<CachedMcpInventory> {
    const client = await connectMcpToolProxyClient(
      capability,
      this.options,
      MCP_TOOL_PROXY_CLIENT_ADAPTERS,
    );
    try {
      signal?.throwIfAborted();
      const tools = await fetchMcpToolListPages({
        client,
        timeoutMs: MCP_PROXY_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      });
      signal?.throwIfAborted();
      const listedTools: ListedMcpTool[] = [];
      let totalAllowed = 0;
      for (const tool of tools.tools) {
        if (!isSourceInventoryToolAllowed(capability, tool.name)) continue;
        totalAllowed += 1;
        listedTools.push(listedMcpTool(capability, tool));
      }
      return cacheMcpInventory(input, capability, {
        tools: listedTools,
        totalAllowed,
        remoteListPageCount: tools.pageCount,
        remoteListTruncated: tools.truncated,
      });
    } finally {
      scheduleMcpClientIdleClose(capability);
    }
  }

  private async publishMcpToolActivity(input: {
    input: {
      appId: AppId;
      agentId: AgentId;
      conversationId?: string;
      threadId?: string;
      serverName: string;
      toolName: string;
    };
    resultClass: McpToolAuditResultClass;
    latencyMs: number;
    argumentSummary: Record<string, unknown>;
    selectedToolRule?: string;
    selectedCapability?: Pick<
      ReviewedMaterializedMcpCapability,
      'name' | 'serverId' | 'bindingId' | 'sourceRevision'
    >;
    reason?: string;
    error?: Record<string, unknown>;
    outputSchemaPresent?: boolean;
    structuredResultValidated?: boolean;
    toolResultError?: boolean;
  }): Promise<void> {
    await publishMcpToolActivity({
      mcpServers: this.mcpServers,
      options: this.options,
      activity: input,
    });
  }

  private async materializeSourceCapabilities(input: {
    appId: AppId;
    agentId: AgentId;
    conversationId?: string;
    threadId?: string;
  }): Promise<ReviewedMaterializedMcpCapability[]> {
    return materializeSourceMcpCapabilities({
      mcpServers: this.mcpServers,
      tools: this.options.tools,
      skills: this.options.skills,
      credentialEnv: this.options.credentialEnv,
      sourceServerIds: this.options.sourceServerIds,
      lookupHostname: this.options.lookupHostname,
      dnsValidationCache: this.options.dnsValidationCache,
      appId: input.appId,
      agentId: input.agentId,
      conversationId: input.conversationId,
      threadId: input.threadId,
    });
  }

  private async materializeReviewedCapabilities(input: {
    appId: AppId;
    agentId: AgentId;
    conversationId?: string;
    threadId?: string;
  }): Promise<ReviewedMaterializedMcpCapability[]> {
    return materializeReviewedMcpCapabilities({
      mcpServers: this.mcpServers,
      tools: this.options.tools,
      skills: this.options.skills,
      credentialEnv: this.options.credentialEnv,
      liveToolRules: this.options.liveToolRules,
      lookupHostname: this.options.lookupHostname,
      dnsValidationCache: this.options.dnsValidationCache,
      appId: input.appId,
      agentId: input.agentId,
      conversationId: input.conversationId,
      threadId: input.threadId,
    });
  }

  private async resolveReviewedTool(
    input: {
      appId: AppId;
      agentId: AgentId;
      serverName: string;
      toolName: string;
    },
    finalizeDenied: (
      resultClass: McpToolAuditResultClass,
      extra?: Record<string, unknown>,
    ) => Promise<unknown>,
  ): Promise<{
    capability: ReviewedMaterializedMcpCapability;
    selectedToolRule: string;
    selectedCapability: Pick<
      ReviewedMaterializedMcpCapability,
      'name' | 'serverId' | 'bindingId' | 'sourceRevision'
    >;
  }> {
    return resolveReviewedMcpTool({
      capabilities: await this.materializeReviewedCapabilities(input),
      serverName: input.serverName,
      toolName: input.toolName,
      finalizeDenied,
    });
  }
}
