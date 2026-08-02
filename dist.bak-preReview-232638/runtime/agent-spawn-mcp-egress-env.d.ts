import type { MaterializedMcpCapability } from '../application/mcp/mcp-server-service.js';
export declare function withStdioMcpEgressEnv(capabilities: readonly MaterializedMcpCapability[], toolNetworkEnv: Record<string, string | undefined>): MaterializedMcpCapability[];
