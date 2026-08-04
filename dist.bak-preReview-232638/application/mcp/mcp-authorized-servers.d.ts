import type { McpServerRepository } from '../../domain/ports/repositories.js';
export declare function authorizedMcpServerIdsForAgent(input: {
    mcpServers: McpServerRepository;
    appId: string;
    agentId: string;
}): Promise<string[]>;
