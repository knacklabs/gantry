const MCP_PROXY_CLIENT_IDLE_MS = 120_000;
const clientCache = new Map();
export function readCachedMcpClient(capability) {
    const cached = clientCache.get(mcpClientCacheKey(capability));
    if (!cached)
        return null;
    clearTimeout(cached.idleTimer);
    return cached.client;
}
export function cacheMcpClient(capability, client) {
    clientCache.set(mcpClientCacheKey(capability), {
        client,
        idleTimer: createClientIdleTimer(capability),
        activeCalls: 0,
        closeAfterRelease: false,
    });
}
export function scheduleMcpClientIdleClose(capability) {
    const cached = clientCache.get(mcpClientCacheKey(capability));
    if (!cached)
        return;
    clearTimeout(cached.idleTimer);
    if (cached.activeCalls > 0)
        return;
    cached.idleTimer = createClientIdleTimer(capability);
}
export function retainMcpClient(capability) {
    const cached = clientCache.get(mcpClientCacheKey(capability));
    if (!cached)
        return;
    cached.activeCalls += 1;
    clearTimeout(cached.idleTimer);
}
export function releaseMcpClient(capability) {
    const cached = clientCache.get(mcpClientCacheKey(capability));
    if (!cached)
        return;
    cached.activeCalls = Math.max(0, cached.activeCalls - 1);
    if (cached.activeCalls === 0 && cached.closeAfterRelease) {
        void closeCachedMcpClient(capability);
        return;
    }
    scheduleMcpClientIdleClose(capability);
}
export async function closeCachedMcpClient(capability) {
    const cacheKey = mcpClientCacheKey(capability);
    const cached = clientCache.get(cacheKey);
    if (!cached)
        return;
    if (cached.activeCalls > 0) {
        cached.closeAfterRelease = true;
        clearTimeout(cached.idleTimer);
        return;
    }
    clientCache.delete(cacheKey);
    clearTimeout(cached.idleTimer);
    await cached.client.close();
}
function mcpClientCacheKey(capability) {
    return `${capability.name}:${JSON.stringify(capability.config)}`;
}
function createClientIdleTimer(capability) {
    const timer = setTimeout(() => {
        void closeCachedMcpClient(capability);
    }, MCP_PROXY_CLIENT_IDLE_MS);
    timer.unref?.();
    return timer;
}
