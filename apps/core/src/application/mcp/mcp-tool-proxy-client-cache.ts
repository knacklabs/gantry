import type { MaterializedMcpCapability } from './mcp-server-service.js';

const MCP_PROXY_CLIENT_IDLE_MS = 120_000;

type CloseableMcpClient = {
  close(): Promise<unknown> | unknown;
};

type CachedMcpClient = {
  client: CloseableMcpClient;
  idleTimer: ReturnType<typeof setTimeout>;
};

const clientCache = new Map<string, CachedMcpClient>();

export function readCachedMcpClient(
  capability: MaterializedMcpCapability,
): CloseableMcpClient | null {
  const cached = clientCache.get(mcpClientCacheKey(capability));
  if (!cached) return null;
  clearTimeout(cached.idleTimer);
  return cached.client;
}

export function cacheMcpClient(
  capability: MaterializedMcpCapability,
  client: CloseableMcpClient,
): void {
  clientCache.set(mcpClientCacheKey(capability), {
    client,
    idleTimer: createClientIdleTimer(capability),
  });
}

export function scheduleMcpClientIdleClose(
  capability: MaterializedMcpCapability,
): void {
  const cached = clientCache.get(mcpClientCacheKey(capability));
  if (!cached) return;
  clearTimeout(cached.idleTimer);
  cached.idleTimer = createClientIdleTimer(capability);
}

export async function closeCachedMcpClient(
  capability: MaterializedMcpCapability,
): Promise<void> {
  const cacheKey = mcpClientCacheKey(capability);
  const cached = clientCache.get(cacheKey);
  if (!cached) return;
  clientCache.delete(cacheKey);
  clearTimeout(cached.idleTimer);
  await cached.client.close();
}

function mcpClientCacheKey(capability: MaterializedMcpCapability): string {
  return `${capability.name}:${JSON.stringify(capability.config)}`;
}

function createClientIdleTimer(
  capability: MaterializedMcpCapability,
): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    void closeCachedMcpClient(capability);
  }, MCP_PROXY_CLIENT_IDLE_MS);
  (timer as { unref?: () => void }).unref?.();
  return timer;
}
