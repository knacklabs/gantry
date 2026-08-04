import type { MaterializedMcpServer } from '../../domain/mcp/mcp-servers.js';
export type SdkMcpServerConfig = {
    type?: 'stdio';
    command: string;
    args?: string[];
    env?: Record<string, string>;
} | {
    type: 'http';
    url: string;
    headers?: Record<string, string>;
} | {
    type: 'sse';
    url: string;
    headers?: Record<string, string>;
};
export interface MaterializedMcpCapability {
    name: string;
    serverId: string;
    bindingId: string;
    sourceRevision?: string;
    config: SdkMcpServerConfig;
    allowedToolPatterns: string[];
    autoApproveToolPatterns: string[];
    allowedToolNames: string[];
    autoApproveToolNames: string[];
    networkHosts: string[];
    required: boolean;
}
export declare function materializeMcpRecord(record: MaterializedMcpServer, credentialEnv: Record<string, string>): MaterializedMcpCapability;
