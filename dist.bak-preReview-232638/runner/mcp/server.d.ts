import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
export { parseCallableAgentManifest } from '../../shared/callable-agent-manifest.js';
export declare function assertRegisteredMcpToolHandlers(input: {
    enabledTools: ReadonlySet<string>;
    registeredHandlers: ReadonlySet<string>;
}): void;
export declare function createGantryMcpServer(): McpServer;
export declare function effectiveEnabledMcpToolNames(rawToolNames: string | undefined, rawAdminToolNames: string | undefined, rawNoPermissionTools?: string | undefined, lockedPreset?: boolean, rawAsyncTaskToolsEnabled?: string | undefined): Set<string>;
