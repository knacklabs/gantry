export const MAX_MCP_REMOTE_LIST_PAGES = 20;
export const MAX_MCP_REMOTE_TOOLS_PER_PAGE = 200;
export const MAX_MCP_REMOTE_TOOLS_TOTAL = 1_000;
export const MAX_MCP_REMOTE_TOOL_METADATA_BYTES = 64 * 1024;
const MAX_MCP_REMOTE_TOOL_NAME_LENGTH = 512;
const MAX_MCP_REMOTE_TOOL_DESCRIPTION_LENGTH = 8 * 1024;
const MAX_MCP_REMOTE_METADATA_COLLECTION_SIZE = 80;
const MAX_MCP_REMOTE_METADATA_DEPTH = 8;
const MCP_REMOTE_METADATA_STRING_LADDER = [2048, 512, 128, 0];
export async function fetchMcpToolListPages(input) {
    const tools = [];
    const seenCursors = new Set();
    let cursor;
    let truncated = false;
    for (let page = 0; page < MAX_MCP_REMOTE_LIST_PAGES; page += 1) {
        const response = await input.client.listTools(cursor ? { cursor } : {}, {
            timeout: input.timeoutMs,
            ...(input.signal ? { signal: input.signal } : {}),
        });
        const remoteTools = Array.isArray(response.tools) ? response.tools : [];
        if (remoteTools.length > MAX_MCP_REMOTE_TOOLS_PER_PAGE) {
            truncated = true;
        }
        for (const rawTool of remoteTools.slice(0, MAX_MCP_REMOTE_TOOLS_PER_PAGE)) {
            const tool = normalizeRemoteMcpTool(rawTool);
            if (!tool) {
                truncated = true;
                continue;
            }
            tools.push(tool);
            if (tools.length >= MAX_MCP_REMOTE_TOOLS_TOTAL) {
                return {
                    tools,
                    pageCount: page + 1,
                    truncated: true,
                    ...(normalizeRemoteCursor(response.nextCursor)
                        ? { nextCursor: normalizeRemoteCursor(response.nextCursor) }
                        : {}),
                };
            }
        }
        const nextCursor = normalizeRemoteCursor(response.nextCursor);
        if (!nextCursor) {
            return { tools, pageCount: page + 1, truncated };
        }
        if (seenCursors.has(nextCursor)) {
            return {
                tools,
                pageCount: page + 1,
                truncated: true,
                nextCursor,
            };
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
    }
    return {
        tools,
        pageCount: MAX_MCP_REMOTE_LIST_PAGES,
        truncated: truncated || Boolean(cursor),
        ...(cursor ? { nextCursor: cursor } : {}),
    };
}
function normalizeRemoteCursor(cursor) {
    return typeof cursor === 'string' && cursor.length > 0 ? cursor : undefined;
}
function normalizeRemoteMcpTool(rawTool) {
    if (!rawTool || typeof rawTool !== 'object' || Array.isArray(rawTool)) {
        return undefined;
    }
    const record = rawTool;
    const name = normalizeRemoteString(record.name, MAX_MCP_REMOTE_TOOL_NAME_LENGTH);
    if (!name)
        return undefined;
    const description = normalizeRemoteString(record.description, MAX_MCP_REMOTE_TOOL_DESCRIPTION_LENGTH);
    const base = {
        name,
        ...(description ? { description } : {}),
    };
    for (const maxStringChars of MCP_REMOTE_METADATA_STRING_LADDER) {
        const bounded = boundRemoteMcpMetadata(record, maxStringChars, 0);
        if (!bounded || typeof bounded !== 'object' || Array.isArray(bounded)) {
            continue;
        }
        const candidate = {
            ...bounded,
            ...base,
        };
        if (approximateBytes(candidate) <= MAX_MCP_REMOTE_TOOL_METADATA_BYTES) {
            return candidate;
        }
    }
    return { ...base, metadataTruncated: true };
}
function normalizeRemoteString(value, maxLength) {
    if (typeof value !== 'string' || value.length === 0)
        return undefined;
    return value.length <= maxLength ? value : value.slice(0, maxLength);
}
function boundRemoteMcpMetadata(value, maxStringChars, depth) {
    if (typeof value === 'string') {
        return value.length <= maxStringChars
            ? value
            : `${value.slice(0, maxStringChars)} [field truncated]`;
    }
    if (value === null ||
        typeof value === 'boolean' ||
        typeof value === 'number') {
        return value;
    }
    if (!value || typeof value !== 'object')
        return undefined;
    if (depth >= MAX_MCP_REMOTE_METADATA_DEPTH)
        return '[metadata truncated]';
    if (Array.isArray(value)) {
        const items = value
            .slice(0, MAX_MCP_REMOTE_METADATA_COLLECTION_SIZE)
            .map((item) => boundRemoteMcpMetadata(item, maxStringChars, depth + 1));
        if (value.length > MAX_MCP_REMOTE_METADATA_COLLECTION_SIZE) {
            items.push('[metadata truncated]');
        }
        return items;
    }
    const entries = Object.entries(value).slice(0, MAX_MCP_REMOTE_METADATA_COLLECTION_SIZE);
    const output = {};
    for (const [key, nested] of entries) {
        const bounded = boundRemoteMcpMetadata(nested, maxStringChars, depth + 1);
        if (bounded !== undefined)
            output[key] = bounded;
    }
    if (Object.keys(value).length > MAX_MCP_REMOTE_METADATA_COLLECTION_SIZE) {
        output.metadataTruncated = true;
    }
    return output;
}
function approximateBytes(value) {
    try {
        return Buffer.byteLength(JSON.stringify(value), 'utf8');
    }
    catch {
        return Number.POSITIVE_INFINITY;
    }
}
