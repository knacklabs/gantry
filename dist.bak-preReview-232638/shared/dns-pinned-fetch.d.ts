export type DnsPinnedHostnameLookup = (hostname: string) => Promise<Array<{
    address: string;
    family: 4 | 6;
}>>;
/**
 * SSRF-safe DNS-pinned fetch for remote third-party MCP transports.
 *
 * The hostname is resolved once, validated to be public-routable, and the
 * resulting IP is pinned for the connection via a custom `lookup`, while TLS SNI
 * and certificate validation stay bound to the original hostname.
 */
export declare function createDnsPinnedMcpFetch(input: {
    lookupHostname?: DnsPinnedHostnameLookup;
}): typeof fetch;
export declare function resolvePinnedPublicMcpAddress(hostname: string, lookupHostname?: DnsPinnedHostnameLookup): Promise<{
    address: string;
    family: 4 | 6;
}>;
