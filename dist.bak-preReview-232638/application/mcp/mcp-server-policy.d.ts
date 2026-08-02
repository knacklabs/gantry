import type { McpCredentialRef, McpServerTransportConfig } from '../../domain/mcp/mcp-servers.js';
import { type HostnameLookup } from '../../domain/network/public-address-policy.js';
export declare const STDIO_TEMPLATE_COMMANDS: Record<string, {
    command: string;
    args: string[];
}>;
/**
 * Validate and normalize declared MCP server network hosts. Third-party MCP
 * source install/bind is inventory only; approved tool patterns define operation
 * authority, while declared hosts are review/audit metadata. For remote http/sse
 * servers the configured URL host is added automatically when omitted so review
 * prompts and audit can show the connection target.
 */
export declare function normalizeMcpNetworkHosts(input: {
    serverName: string;
    networkHosts: readonly string[] | undefined;
    config: McpServerTransportConfig;
}): string[];
/**
 * Validate and normalize a per-agent MCP tool scope. Each requested pattern must
 * be covered by the server definition's reviewed `allowedToolPatterns`, so a
 * binding can only narrow (e.g. read-only) — never widen beyond what was
 * reviewed. Empty means the agent inherits the definition's full set.
 */
export declare function normalizeAgentMcpToolScope(input: {
    serverName: string;
    requested: readonly string[] | undefined;
    definitionPatterns: readonly string[];
}): string[];
export declare function validateTransportConfig(config: McpServerTransportConfig, options?: {
    sandboxProfileId?: string;
}): void;
export declare function assertRemoteMcpDestinationPublic(config: McpServerTransportConfig, lookupHostname?: HostnameLookup, options?: {
    cache?: RemoteMcpDnsValidationCache;
    nowMs?: number;
    ttlMs?: number;
    lookupTimeoutMs?: number;
}): Promise<void>;
export declare class RemoteMcpDnsValidationCache {
    private readonly cache;
    private readonly pending;
    get(hostname: string): {
        expiresAtMs: number;
    } | undefined;
    set(hostname: string, entry: {
        expiresAtMs: number;
    }): void;
    delete(hostname: string): void;
    getPending(hostname: string): Promise<void> | undefined;
    setPending(hostname: string, promise: Promise<void>): void;
}
export declare function validateCredentialRefs(refs: McpCredentialRef[]): void;
export declare function normalizeCredentialRefs(refs: readonly McpCredentialRef[]): McpCredentialRef[];
