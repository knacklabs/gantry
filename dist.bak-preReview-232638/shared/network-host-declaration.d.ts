export type DeclaredNetworkHostResult = {
    ok: true;
    host: string;
} | {
    ok: false;
    reason: string;
};
/**
 * Validate and normalize a single declared outbound network target.
 *
 * Declared hosts are exact `host` or `host:port` values. This is the shared
 * authority parser for skill-action and third-party MCP network declarations:
 * it rejects URLs, schemes, paths, credentials, wildcards, empty hosts, invalid
 * ports, and localhost/private/loopback targets, then lowercases, strips
 * trailing dots, and returns a canonical value safe to dedupe. Callers prefix
 * the `reason` with their own subject (for example
 * `Skill action <id> networkHosts <reason>`).
 */
export declare function parseDeclaredNetworkHost(value: string): DeclaredNetworkHostResult;
/**
 * The exact network authority (`host:port`) represented by a declared or
 * observed network host. Missing ports default to 443 because these declarations
 * authorize outbound HTTPS/API access rather than arbitrary port access.
 */
export declare function declaredNetworkAuthority(value: string): string | undefined;
export declare function hostnameForNetwork(input: string): string;
export declare function isIpAddress(address: string): boolean;
export declare function isPrivateNetworkAddress(address: string): boolean;
