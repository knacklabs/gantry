import { Transform } from 'node:stream';
import type { MaterializedMcpCapability } from '../../../../application/mcp/mcp-server-service.js';
import type { HostnameLookup } from '../../../../domain/network/public-address-policy.js';
export interface ProxiedClaudeMcpServer {
    name: string;
    type: 'http' | 'sse';
    url: string;
    headers: Record<string, string>;
    allowedToolPatterns: readonly string[];
}
export interface SseProxyEndpointState {
    advertisedTarget?: URL;
}
export declare function createPinnedClaudeMcpProxies(input: {
    servers: readonly MaterializedMcpCapability[];
    egressDenylist: readonly string[];
    lookupHostname?: HostnameLookup;
}): Promise<{
    servers: ProxiedClaudeMcpServer[];
    close(): Promise<void>;
}>;
export declare function proxyTarget(requestUrl: string | undefined, configuredTarget: URL, targetType: 'http' | 'sse', sseEndpointState?: SseProxyEndpointState): URL;
export declare function createSseEndpointCapture(configuredTarget: URL, state: SseProxyEndpointState, proxyTarget: URL): Transform;
