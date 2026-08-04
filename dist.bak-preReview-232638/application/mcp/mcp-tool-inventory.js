const MCP_INVENTORY_CACHE_TTL_MS = 60_000;
const DEFAULT_MCP_LIST_LIMIT = 20;
const MAX_MCP_LIST_LIMIT = 50;
const inventoryCache = new Map();
const toolDetailCache = new Map();
export const MCP_SOURCE_INVENTORY_DENIAL_REASON = 'Source inventory only; mcp_call_tool rechecks reviewed current-run action capability at call time.';
export function clearMcpToolProxyInventoryCache() {
    inventoryCache.clear();
    toolDetailCache.clear();
}
export function invalidateMcpToolProxyInventoryCacheForCapability(capability) {
    let deleted = 0;
    for (const key of [...inventoryCache.keys()]) {
        if (!cacheKeyMatchesCapability(key, capability))
            continue;
        inventoryCache.delete(key);
        deleted += 1;
    }
    for (const key of [...toolDetailCache.keys()]) {
        if (!cacheKeyMatchesCapability(key, capability))
            continue;
        toolDetailCache.delete(key);
        deleted += 1;
    }
    return deleted;
}
export function cacheMcpInventory(input, capability, inventory) {
    const cached = {
        expiresAt: Date.now() + MCP_INVENTORY_CACHE_TTL_MS,
        ...inventory,
    };
    inventoryCache.set(mcpInventoryCacheKey(input, capability), cached);
    return cached;
}
export function readCachedMcpInventory(input, capability) {
    const key = mcpInventoryCacheKey(input, capability);
    const cached = inventoryCache.get(key);
    if (!cached)
        return undefined;
    if (cached.expiresAt <= Date.now()) {
        inventoryCache.delete(key);
        return undefined;
    }
    return cached;
}
export function cacheMcpToolDetail(input, capability, toolName, detail) {
    const cached = {
        expiresAt: Date.now() + MCP_INVENTORY_CACHE_TTL_MS,
        ...detail,
    };
    toolDetailCache.set(mcpToolDetailCacheKey(input, capability, toolName), cached);
    return cached;
}
export function readCachedMcpToolDetail(input, capability, toolName) {
    const key = mcpToolDetailCacheKey(input, capability, toolName);
    const cached = toolDetailCache.get(key);
    if (!cached)
        return undefined;
    if (cached.expiresAt <= Date.now()) {
        toolDetailCache.delete(key);
        return undefined;
    }
    return cached;
}
export function approximateMcpMetadataBytes(value) {
    try {
        return Buffer.byteLength(JSON.stringify(value));
    }
    catch {
        return 'unavailable';
    }
}
export function normalizeMcpListLimit(limit) {
    if (typeof limit !== 'number' || !Number.isFinite(limit)) {
        return DEFAULT_MCP_LIST_LIMIT;
    }
    return Math.max(1, Math.min(MAX_MCP_LIST_LIMIT, Math.trunc(limit)));
}
export function normalizeMcpListCursor(cursor) {
    if (!cursor)
        return 0;
    const parsed = Number.parseInt(cursor, 10);
    if (!Number.isFinite(parsed) || parsed < 0)
        return 0;
    return parsed;
}
export function mcpToolMatchesQuery(item, query) {
    if (!query)
        return true;
    const terms = mcpToolSearchTerms(query);
    const searchable = [
        item.serverName,
        item.tool.name,
        item.tool.description ?? '',
    ]
        .join(' ')
        .toLowerCase();
    return terms.length > 0 && terms.every((term) => searchable.includes(term));
}
export function compareMcpToolSearchResults(left, right, query) {
    const scoreDelta = mcpToolSearchScore(right, query) - mcpToolSearchScore(left, query);
    if (scoreDelta !== 0)
        return scoreDelta;
    const serverDelta = left.serverName.localeCompare(right.serverName);
    if (serverDelta !== 0)
        return serverDelta;
    return left.tool.name.localeCompare(right.tool.name);
}
export function mcpToolRef(serverName, toolName) {
    return `mcp://${encodeURIComponent(serverName)}/tools/${encodeURIComponent(toolName)}`;
}
export function listedMcpTool(capability, tool) {
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
export function detailedMcpTool(capability, tool) {
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
function mcpInventoryCacheKey(input, capability) {
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
function mcpToolDetailCacheKey(input, capability, toolName) {
    return JSON.stringify({
        appId: input.appId,
        agentId: input.agentId,
        serverName: capability.name,
        sourceRevision: capability.sourceRevision,
        config: capability.config,
        toolName,
    });
}
function cacheKeyMatchesCapability(key, capability) {
    const parsed = parseInventoryCacheKey(key);
    if (!parsed)
        return false;
    return (parsed.serverName === capability.name &&
        JSON.stringify(parsed.config) === JSON.stringify(capability.config));
}
function parseInventoryCacheKey(key) {
    try {
        return JSON.parse(key);
    }
    catch {
        return undefined;
    }
}
function mcpToolSearchScore(item, query) {
    if (!query)
        return 0;
    const toolName = item.tool.name.toLowerCase();
    const description = item.tool.description?.toLowerCase() ?? '';
    const serverName = item.serverName.toLowerCase();
    return mcpToolSearchTerms(query).reduce((score, term) => {
        if (toolName === term)
            return score + 100;
        if (toolName.startsWith(term))
            return score + 80;
        if (toolName.includes(term))
            return score + 60;
        if (description.includes(term))
            return score + 40;
        if (serverName.includes(term))
            return score + 20;
        return score;
    }, 0);
}
function mcpToolSearchTerms(query) {
    return query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}
