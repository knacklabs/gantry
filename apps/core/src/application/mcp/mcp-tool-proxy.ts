import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type {
  AgentRunId,
  RuntimeEventPublishInput,
} from '../../domain/events/events.js';
import { RUNTIME_EVENT_TYPES } from '../../domain/events/runtime-event-types.js';
import type {
  McpServerRepository,
  SkillCatalogRepository,
  ToolCatalogRepository,
} from '../../domain/ports/repositories.js';
import type { HostnameLookup } from '../../domain/network/public-address-policy.js';
import { nowIso } from '../../shared/time/datetime.js';
import { ApplicationError } from '../common/application-error.js';
import {
  RemoteMcpDnsValidationCache,
  assertRemoteMcpDestinationPublic,
} from './mcp-server-policy.js';
import {
  assertMcpNetworkHostAllowed,
  createGuardedMcpFetch,
  isLocalLoopbackHttpMcpUrl,
} from './mcp-tool-proxy-network.js';
import {
  isReviewedMcpToolAllowed,
  isSourceInventoryToolAllowed,
  type ReviewedMaterializedMcpCapability,
} from './mcp-tool-authorization.js';
import { resolveReviewedMcpTool } from './mcp-reviewed-tool-resolution.js';
import type { MaterializedMcpCapability } from './mcp-server-service.js';
import {
  materializeReviewedMcpCapabilities,
  materializeSourceMcpCapabilities,
} from './mcp-tool-proxy-capabilities.js';
import {
  cacheMcpInventory,
  compareMcpToolSearchResults,
  type CachedMcpInventory,
  type DetailedMcpTool,
  invalidateMcpToolProxyInventoryCacheForCapability,
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
  cacheMcpClient,
  closeCachedMcpClient,
  releaseMcpClient,
  readCachedMcpClient,
  retainMcpClient,
  scheduleMcpClientIdleClose,
} from './mcp-tool-proxy-client-cache.js';

export { clearMcpToolProxyInventoryCache } from './mcp-tool-inventory.js';
export {
  assertMcpNetworkHostAllowed,
  createGuardedMcpFetch,
} from './mcp-tool-proxy-network.js';

const MCP_PROXY_TIMEOUT_MS = 60_000;
const MCP_INVENTORY_SEARCH_CONCURRENCY = 4;

interface McpToolCallInput {
  appId: AppId;
  agentId: AgentId;
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
    query: string;
    limit?: number;
  }): Promise<McpToolSearchResult> {
    const [listed, reviewedCapabilities] = await Promise.all([
      this.listTools({
        appId: input.appId,
        agentId: input.agentId,
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
    const client = await this.connect(capability);
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
      const client = await this.connect(capability);
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
    const client = await this.connect(capability);
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
    const payload = {
      serverName: input.input.serverName,
      toolName: input.input.toolName,
      requestedToolRule: `mcp__${input.input.serverName}__${input.input.toolName}`,
      ...(input.selectedToolRule
        ? { selectedToolRule: input.selectedToolRule }
        : {}),
      ...(input.selectedCapability
        ? {
            selectedCapability: {
              sourceId: `mcp:${input.selectedCapability.name}`,
              serverId: input.selectedCapability.serverId,
              bindingId: input.selectedCapability.bindingId,
              ...(input.selectedCapability.sourceRevision
                ? { sourceRevision: input.selectedCapability.sourceRevision }
                : {}),
            },
          }
        : {}),
      resultClass: input.resultClass,
      latencyMs: input.latencyMs,
      argumentSummary: input.argumentSummary,
      ...(input.reason ? { reason: input.reason } : {}),
      ...(input.error ? { error: input.error } : {}),
      ...(typeof input.outputSchemaPresent === 'boolean'
        ? { outputSchemaPresent: input.outputSchemaPresent }
        : {}),
      ...(typeof input.structuredResultValidated === 'boolean'
        ? { structuredResultValidated: input.structuredResultValidated }
        : {}),
      ...(typeof input.toolResultError === 'boolean'
        ? { toolResultError: input.toolResultError }
        : {}),
      ...(this.options.runHandle ? { runHandle: this.options.runHandle } : {}),
    };
    await this.mcpServers.appendAuditEvent({
      id: `mcp-audit:${globalThis.crypto.randomUUID()}` as never,
      appId: input.input.appId,
      agentId: input.input.agentId,
      eventType: 'tool_activity',
      actorId: 'mcp-tool-proxy',
      ...(input.reason ? { reason: input.reason } : {}),
      metadata: payload,
      createdAt: nowIso() as never,
    });
    if (!this.options.publishRuntimeEvent) return;
    try {
      await this.options.publishRuntimeEvent({
        appId: input.input.appId,
        agentId: input.input.agentId,
        ...(this.options.runId
          ? { runId: this.options.runId as AgentRunId }
          : {}),
        eventType: RUNTIME_EVENT_TYPES.MCP_TOOL_ACTIVITY,
        actor: 'mcp-tool-proxy',
        responseMode: 'none',
        payload,
      });
    } catch {
      // The MCP audit table is the durable authority for tool-call evidence.
      // Runtime events are an observable projection and must not make a
      // completed external side effect look retryable to the model.
    }
  }

  private async materializeSourceCapabilities(input: {
    appId: AppId;
    agentId: AgentId;
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
    });
  }

  private async materializeReviewedCapabilities(input: {
    appId: AppId;
    agentId: AgentId;
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

  private async connect(
    capability: MaterializedMcpCapability,
  ): Promise<Client> {
    this.assertNetworkAllowedForCapability(capability);
    const cached = readCachedMcpClient(capability) as Client | null;
    if (cached) return cached;
    const client = new Client(
      { name: 'gantry-mcp-proxy', version: '1.0.0' },
      {
        capabilities: {},
        listChanged: {
          tools: {
            autoRefresh: false,
            debounceMs: 250,
            onChanged: () => {
              invalidateMcpToolProxyInventoryCacheForCapability(capability);
            },
          },
        },
      },
    );
    const transport = await this.createTransport(capability);
    await client.connect(transport, { timeout: MCP_PROXY_TIMEOUT_MS });
    const existing = readCachedMcpClient(capability) as Client | null;
    if (existing) {
      await client.close();
      return existing;
    }
    cacheMcpClient(capability, client);
    return client;
  }

  private async createTransport(capability: MaterializedMcpCapability) {
    const config = capability.config;
    if (config.type === 'http' || config.type === 'sse') {
      if (!isLocalLoopbackHttpMcpUrl(new URL(config.url))) {
        await assertRemoteMcpDestinationPublic(
          { transport: config.type, url: config.url, headers: config.headers },
          this.options.lookupHostname,
          { cache: this.options.dnsValidationCache },
        );
      }
      const allowLoopbackHttp = isLocalLoopbackHttpMcpUrl(new URL(config.url));
      const fetch = createGuardedMcpFetch({
        allowLoopbackHttp,
        lookupHostname: this.options.lookupHostname,
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
      denylist: this.options.egressDenylist ?? [],
    });
  }
}
