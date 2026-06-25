import type { MaterializedMcpCapability } from './mcp-server-service.js';

const MCP_PROXY_CLIENT_IDLE_MS = 120_000;

type CloseableMcpClient = {
  close(): Promise<unknown> | unknown;
};

type CachedMcpClient = {
  client: CloseableMcpClient;
  idleTimer: ReturnType<typeof setTimeout>;
  activeCalls: number;
  closeAfterRelease: boolean;
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
    activeCalls: 0,
    closeAfterRelease: false,
  });
}

export function scheduleMcpClientIdleClose(
  capability: MaterializedMcpCapability,
): void {
  const cached = clientCache.get(mcpClientCacheKey(capability));
  if (!cached) return;
  clearTimeout(cached.idleTimer);
  if (cached.activeCalls > 0) return;
  cached.idleTimer = createClientIdleTimer(capability);
}

export function retainMcpClient(capability: MaterializedMcpCapability): void {
  const cached = clientCache.get(mcpClientCacheKey(capability));
  if (!cached) return;
  cached.activeCalls += 1;
  clearTimeout(cached.idleTimer);
}

export function releaseMcpClient(capability: MaterializedMcpCapability): void {
  const cached = clientCache.get(mcpClientCacheKey(capability));
  if (!cached) return;
  cached.activeCalls = Math.max(0, cached.activeCalls - 1);
  if (cached.activeCalls === 0 && cached.closeAfterRelease) {
    void closeCachedMcpClient(capability);
    return;
  }
  scheduleMcpClientIdleClose(capability);
}

export async function closeCachedMcpClient(
  capability: MaterializedMcpCapability,
): Promise<void> {
  const cacheKey = mcpClientCacheKey(capability);
  const cached = clientCache.get(cacheKey);
  if (!cached) return;
  if (cached.activeCalls > 0) {
    cached.closeAfterRelease = true;
    clearTimeout(cached.idleTimer);
    return;
  }
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
