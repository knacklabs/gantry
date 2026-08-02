import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type { McpServerId } from '../../domain/mcp/mcp-servers.js';
import type { CapabilitySecretRepository, McpServerRepository } from '../../domain/ports/repositories.js';
export declare function resolveMcpCredentialEnvForAgent(input: {
    appId: AppId;
    agentId: AgentId;
    mcpServers: McpServerRepository;
    secrets: CapabilitySecretRepository;
    serverIds?: readonly McpServerId[];
}): Promise<Record<string, string>>;
