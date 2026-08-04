import type { HostnameLookup } from '../../domain/network/public-address-policy.js';
export declare function assertMcpNetworkHostAllowed(input: {
    serverName: string;
    url: string;
    denylist: readonly string[];
}): void;
export declare function createGuardedMcpFetch(input: {
    allowLoopbackHttp?: boolean;
    lookupHostname?: HostnameLookup;
}): typeof fetch;
export declare function isLocalLoopbackHttpMcpUrl(url: URL): boolean;
