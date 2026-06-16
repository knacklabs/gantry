export const MAX_MCP_REMOTE_LIST_PAGES = 20;

export type McpListedToolMetadata = {
  name: string;
  description?: string;
} & Record<string, unknown>;

export type McpToolListClient = {
  listTools(
    params?: { cursor?: string },
    options?: { timeout?: number },
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
}): Promise<McpToolListPageResult> {
  const tools: McpListedToolMetadata[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < MAX_MCP_REMOTE_LIST_PAGES; page += 1) {
    const response = await input.client.listTools(cursor ? { cursor } : {}, {
      timeout: input.timeoutMs,
    });
    tools.push(...response.tools);
    const nextCursor = normalizeRemoteCursor(response.nextCursor);
    if (!nextCursor) {
      return { tools, pageCount: page + 1, truncated: false };
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
    truncated: Boolean(cursor),
    ...(cursor ? { nextCursor: cursor } : {}),
  };
}

function normalizeRemoteCursor(cursor: unknown): string | undefined {
  return typeof cursor === 'string' && cursor.length > 0 ? cursor : undefined;
}
