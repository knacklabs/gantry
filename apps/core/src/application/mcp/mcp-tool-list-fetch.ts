export const MAX_MCP_REMOTE_LIST_PAGES = 20;
export const MAX_MCP_REMOTE_TOOLS_PER_PAGE = 200;
export const MAX_MCP_REMOTE_TOOLS_TOTAL = 1_000;
export const MAX_MCP_REMOTE_TOOL_METADATA_BYTES = 64 * 1024;

const MAX_MCP_REMOTE_TOOL_NAME_LENGTH = 512;
const MAX_MCP_REMOTE_TOOL_DESCRIPTION_LENGTH = 8 * 1024;
const MAX_MCP_REMOTE_METADATA_COLLECTION_SIZE = 80;
const MAX_MCP_REMOTE_METADATA_DEPTH = 8;
const MAX_MCP_REMOTE_SCHEMA_DEPTH = 32;
const MAX_MCP_REMOTE_SCHEMA_NODES = 10_000;
const MAX_MCP_REMOTE_SCHEMA_BYTES = 48 * 1024;
const MCP_REMOTE_METADATA_STRING_LADDER = [2048, 512, 128, 0] as const;

export type McpListedToolMetadata = {
  name: string;
  description?: string;
} & Record<string, unknown>;

export type McpToolListClient = {
  listTools(
    params?: { cursor?: string },
    options?: { timeout?: number; signal?: AbortSignal },
  ): Promise<{
    tools: McpListedToolMetadata[];
    nextCursor?: string;
  }>;
};

export type McpToolListPageResult = {
  tools: McpListedToolMetadata[];
  pageCount: number;
  truncated: boolean;
  nextCursor?: string;
};

export async function fetchMcpToolListPages(input: {
  client: McpToolListClient;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<McpToolListPageResult> {
  const tools: McpListedToolMetadata[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
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

function normalizeRemoteCursor(cursor: unknown): string | undefined {
  return typeof cursor === 'string' && cursor.length > 0 ? cursor : undefined;
}

function normalizeRemoteMcpTool(
  rawTool: unknown,
): McpListedToolMetadata | undefined {
  if (!rawTool || typeof rawTool !== 'object' || Array.isArray(rawTool)) {
    return undefined;
  }
  const record = rawTool as Record<string, unknown>;
  const name = normalizeRemoteString(
    record.name,
    MAX_MCP_REMOTE_TOOL_NAME_LENGTH,
  );
  if (!name) return undefined;
  const description = normalizeRemoteString(
    record.description,
    MAX_MCP_REMOTE_TOOL_DESCRIPTION_LENGTH,
  );
  const base: McpListedToolMetadata = {
    name,
    ...(description ? { description } : {}),
  };
  const inputSchema = exactBoundedRemoteSchema(record.inputSchema);
  const outputSchema = exactBoundedRemoteSchema(record.outputSchema);
  const metadata = { ...record };
  if (inputSchema) delete metadata.inputSchema;
  if (outputSchema) delete metadata.outputSchema;
  for (const maxStringChars of MCP_REMOTE_METADATA_STRING_LADDER) {
    const bounded = boundRemoteMcpMetadata(metadata, maxStringChars, 0);
    if (!bounded || typeof bounded !== 'object' || Array.isArray(bounded)) {
      continue;
    }
    const candidate = {
      ...(bounded as Record<string, unknown>),
      ...base,
      ...(inputSchema ? { inputSchema } : {}),
      ...(outputSchema ? { outputSchema } : {}),
    } as McpListedToolMetadata;
    if (approximateBytes(candidate) <= MAX_MCP_REMOTE_TOOL_METADATA_BYTES) {
      return candidate;
    }
  }
  return {
    ...base,
    ...(inputSchema ? { inputSchema } : {}),
    ...(outputSchema ? { outputSchema } : {}),
    metadataTruncated: true,
  };
}

function exactBoundedRemoteSchema(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  if (approximateBytes(value) > MAX_MCP_REMOTE_SCHEMA_BYTES) return undefined;
  let nodes = 0;
  const visit = (current: unknown, depth: number): boolean => {
    nodes += 1;
    if (nodes > MAX_MCP_REMOTE_SCHEMA_NODES || depth > MAX_MCP_REMOTE_SCHEMA_DEPTH) {
      return false;
    }
    if (!current || typeof current !== 'object') return true;
    if (Array.isArray(current)) {
      return current.every((child) => visit(child, depth + 1));
    }
    return Object.values(current as Record<string, unknown>).every((child) =>
      visit(child, depth + 1),
    );
  };
  return visit(value, 0) ? (value as Record<string, unknown>) : undefined;
}

function normalizeRemoteString(
  value: unknown,
  maxLength: number,
): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function boundRemoteMcpMetadata(
  value: unknown,
  maxStringChars: number,
  depth: number,
): unknown {
  if (typeof value === 'string') {
    return value.length <= maxStringChars
      ? value
      : `${value.slice(0, maxStringChars)} [field truncated]`;
  }
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    return value;
  }
  if (!value || typeof value !== 'object') return undefined;
  if (depth >= MAX_MCP_REMOTE_METADATA_DEPTH) return '[metadata truncated]';
  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_MCP_REMOTE_METADATA_COLLECTION_SIZE)
      .map((item) => boundRemoteMcpMetadata(item, maxStringChars, depth + 1));
    if (value.length > MAX_MCP_REMOTE_METADATA_COLLECTION_SIZE) {
      items.push('[metadata truncated]');
    }
    return items;
  }
  const entries = Object.entries(value).slice(
    0,
    MAX_MCP_REMOTE_METADATA_COLLECTION_SIZE,
  );
  const output: Record<string, unknown> = {};
  for (const [key, nested] of entries) {
    const bounded = boundRemoteMcpMetadata(nested, maxStringChars, depth + 1);
    if (bounded !== undefined) output[key] = bounded;
  }
  if (Object.keys(value).length > MAX_MCP_REMOTE_METADATA_COLLECTION_SIZE) {
    output.metadataTruncated = true;
  }
  return output;
}

function approximateBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
