import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type { MaterializedMcpCapability } from './mcp-server-service.js';

const MCP_INVENTORY_CACHE_TTL_MS = 60_000;
const DEFAULT_MCP_LIST_LIMIT = 20;
const MAX_MCP_LIST_LIMIT = 50;

export type ListedMcpTool = {
  name: string;
  description?: string;
  toolRef: string;
  serverName: string;
  sourceId: string;
  callable: false;
  denialReason: string;
};

export type DetailedMcpTool = ListedMcpTool & {
  metadataAuthority: 'untrusted_mcp_server';
  title?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
  diagnostics?: McpToolDetailDiagnostics;
};

export type McpToolListDiagnostics = {
  connectedServerCount: number;
  deferredServerCount: number;
  inventoryCacheHits: number;
  inventoryCacheMisses: number;
  liveListCalls: number;
  liveListMs: number;
  remoteListPageCount: number;
  remoteListTruncated: boolean;
  discoveredToolCount: number;
  loadedToolCount: number;
  selectedToolCount: number;
  returnedToolCount: number;
};

export type McpToolDetailDiagnostics = {
  detailCacheHits: number;
  detailCacheMisses: number;
  liveDetailCalls: number;
  liveDetailMs: number;
  metadataBytes: number | 'unavailable';
};

export type CachedMcpInventory = {
  expiresAt: number;
  tools: ListedMcpTool[];
  totalAllowed: number;
  remoteListPageCount: number;
  remoteListTruncated: boolean;
};

export type CachedMcpToolDetail = {
  expiresAt: number;
  tool: Omit<DetailedMcpTool, 'diagnostics'>;
  metadataBytes: number | 'unavailable';
};

type McpInventoryCapability = Pick<
  MaterializedMcpCapability,
  | 'name'
  | 'sourceRevision'
  | 'config'
  | 'allowedToolPatterns'
  | 'allowedToolNames'
> & {
  reviewedToolNames: string[];
};

const inventoryCache = new Map<string, CachedMcpInventory>();
const toolDetailCache = new Map<string, CachedMcpToolDetail>();

export const MCP_SOURCE_INVENTORY_DENIAL_REASON =
  'Source inventory only; mcp_call_tool rechecks reviewed current-run action capability at call time.';

export function clearMcpToolProxyInventoryCache(): void {
  inventoryCache.clear();
  toolDetailCache.clear();
}

export function invalidateMcpToolProxyInventoryCacheForCapability(
  capability: Pick<MaterializedMcpCapability, 'name' | 'config'>,
): number {
  let deleted = 0;
  for (const key of [...inventoryCache.keys()]) {
    if (!cacheKeyMatchesCapability(key, capability)) continue;
    inventoryCache.delete(key);
    deleted += 1;
  }
  for (const key of [...toolDetailCache.keys()]) {
    if (!cacheKeyMatchesCapability(key, capability)) continue;
    toolDetailCache.delete(key);
    deleted += 1;
  }
  return deleted;
}

export function cacheMcpInventory(
  input: { appId: AppId; agentId: AgentId },
  capability: McpInventoryCapability,
  inventory: Omit<CachedMcpInventory, 'expiresAt'>,
): CachedMcpInventory {
  const cached = {
    expiresAt: Date.now() + MCP_INVENTORY_CACHE_TTL_MS,
    ...inventory,
  };
  inventoryCache.set(mcpInventoryCacheKey(input, capability), cached);
  return cached;
}

export function readCachedMcpInventory(
  input: { appId: AppId; agentId: AgentId },
  capability: McpInventoryCapability,
): CachedMcpInventory | undefined {
  const key = mcpInventoryCacheKey(input, capability);
  const cached = inventoryCache.get(key);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    inventoryCache.delete(key);
    return undefined;
  }
  return cached;
}

export function cacheMcpToolDetail(
  input: { appId: AppId; agentId: AgentId },
  capability: McpInventoryCapability,
  toolName: string,
  detail: Omit<CachedMcpToolDetail, 'expiresAt'>,
): CachedMcpToolDetail {
  const cached = {
    expiresAt: Date.now() + MCP_INVENTORY_CACHE_TTL_MS,
    ...detail,
  };
  toolDetailCache.set(
    mcpToolDetailCacheKey(input, capability, toolName),
    cached,
  );
  return cached;
}

export function readCachedMcpToolDetail(
  input: { appId: AppId; agentId: AgentId },
  capability: McpInventoryCapability,
  toolName: string,
): CachedMcpToolDetail | undefined {
  const key = mcpToolDetailCacheKey(input, capability, toolName);
  const cached = toolDetailCache.get(key);
  if (!cached) return undefined;
  if (cached.expiresAt <= Date.now()) {
    toolDetailCache.delete(key);
    return undefined;
  }
  return cached;
}

export function approximateMcpMetadataBytes(
  value: unknown,
): number | 'unavailable' {
  try {
    return Buffer.byteLength(JSON.stringify(value));
  } catch {
    return 'unavailable';
  }
}

export function normalizeMcpListLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    return DEFAULT_MCP_LIST_LIMIT;
  }
  return Math.max(1, Math.min(MAX_MCP_LIST_LIMIT, Math.trunc(limit)));
}

export function normalizeMcpListCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const parsed = Number.parseInt(cursor, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

export function mcpToolMatchesQuery(
  item: {
    serverName: string;
    tool: { name: string; description?: string };
  },
  query: string | undefined,
): boolean {
  if (!query) return true;
  const normalized = query.toLowerCase();
  return [item.serverName, item.tool.name, item.tool.description ?? ''].some(
    (value) => value.toLowerCase().includes(normalized),
  );
}

export function compareMcpToolSearchResults(
  left: {
    serverName: string;
    tool: { name: string; description?: string };
  },
  right: {
    serverName: string;
    tool: { name: string; description?: string };
  },
  query: string | undefined,
): number {
  const scoreDelta =
    mcpToolSearchScore(right, query) - mcpToolSearchScore(left, query);
  if (scoreDelta !== 0) return scoreDelta;
  const serverDelta = left.serverName.localeCompare(right.serverName);
  if (serverDelta !== 0) return serverDelta;
  return left.tool.name.localeCompare(right.tool.name);
}

export function mcpToolRef(serverName: string, toolName: string): string {
  return `mcp://${encodeURIComponent(serverName)}/tools/${encodeURIComponent(
    toolName,
  )}`;
}

export function listedMcpTool(
  capability: MaterializedMcpCapability,
  tool: { name: string; description?: string },
): ListedMcpTool {
  return {
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    toolRef: mcpToolRef(capability.name, tool.name),
    serverName: capability.name,
    sourceId: `mcp:${capability.name}`,
    callable: false,
    denialReason: MCP_SOURCE_INVENTORY_DENIAL_REASON,
  };
}

export function detailedMcpTool(
  capability: MaterializedMcpCapability,
  tool: { name: string; description?: string } & Record<string, unknown>,
): Omit<DetailedMcpTool, 'diagnostics'> {
  return {
    ...listedMcpTool(capability, tool),
    metadataAuthority: 'untrusted_mcp_server',
    ...(typeof tool.title === 'string' ? { title: tool.title } : {}),
    ...(tool.inputSchema !== undefined
      ? { inputSchema: tool.inputSchema }
      : {}),
    ...(tool.outputSchema !== undefined
      ? { outputSchema: tool.outputSchema }
      : {}),
    ...(tool.annotations !== undefined
      ? { annotations: tool.annotations }
      : {}),
  };
}

function mcpInventoryCacheKey(
  input: { appId: AppId; agentId: AgentId },
  capability: McpInventoryCapability,
): string {
  return JSON.stringify({
    appId: input.appId,
    agentId: input.agentId,
    serverName: capability.name,
    sourceRevision: capability.sourceRevision,
    config: capability.config,
    allowedToolPatterns: capability.allowedToolPatterns,
    allowedToolNames: capability.allowedToolNames,
  });
}

function mcpToolDetailCacheKey(
  input: { appId: AppId; agentId: AgentId },
  capability: McpInventoryCapability,
  toolName: string,
): string {
  return JSON.stringify({
    appId: input.appId,
    agentId: input.agentId,
    serverName: capability.name,
    sourceRevision: capability.sourceRevision,
    config: capability.config,
    toolName,
  });
}

function cacheKeyMatchesCapability(
  key: string,
  capability: Pick<MaterializedMcpCapability, 'name' | 'config'>,
): boolean {
  const parsed = parseInventoryCacheKey(key);
  if (!parsed) return false;
  return (
    parsed.serverName === capability.name &&
    JSON.stringify(parsed.config) === JSON.stringify(capability.config)
  );
}

function parseInventoryCacheKey(
  key: string,
): { serverName?: unknown; config?: unknown } | undefined {
  try {
    return JSON.parse(key) as { serverName?: unknown; config?: unknown };
  } catch {
    return undefined;
  }
}

function mcpToolSearchScore(
  item: {
    serverName: string;
    tool: { name: string; description?: string };
  },
  query: string | undefined,
): number {
  if (!query) return 0;
  const normalized = query.toLowerCase();
  const toolName = item.tool.name.toLowerCase();
  const description = item.tool.description?.toLowerCase() ?? '';
  const serverName = item.serverName.toLowerCase();
  if (toolName === normalized) return 100;
  if (toolName.startsWith(normalized)) return 80;
  if (toolName.includes(normalized)) return 60;
  if (description.includes(normalized)) return 40;
  if (serverName.includes(normalized)) return 20;
  return 0;
}
