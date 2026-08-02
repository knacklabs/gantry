import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type { McpServerDefinition, McpServerId } from '../../domain/mcp/mcp-servers.js';
import type { AgentRepository, McpServerRepository, SkillCatalogRepository, ToolCatalogRepository } from '../../domain/ports/repositories.js';
import type { SkillCatalogItem, SkillId } from '../../domain/skills/skills.js';
import type { ToolCatalogItem, ToolId } from '../../domain/tools/tools.js';
import type { AgentCapabilitiesView } from './agent-capability-administration-service.js';
export declare function replaceAgentAccessDocument(input: {
    appId: AppId;
    agentId: AgentId;
    sources: AgentCapabilitiesView['sources'];
    capabilities: Array<{
        id: string;
        version: string;
    }>;
    repositories: {
        agents: AgentRepository;
        tools: ToolCatalogRepository;
        skills: SkillCatalogRepository;
        mcpServers: McpServerRepository;
    };
    now: string;
    requireAgent(appId: AppId, agentId: AgentId): Promise<{
        status: string;
    }>;
    requireInstalledSkills(appId: AppId, skillIds: SkillId[]): Promise<Map<SkillId, SkillCatalogItem>>;
    requireActiveMcpServers(appId: AppId, serverIds: McpServerId[]): Promise<Map<McpServerId, McpServerDefinition>>;
    requireSelectableTools(appId: AppId, toolIds: ToolId[]): Promise<Map<ToolId, ToolCatalogItem>>;
    getCapabilities(input: {
        appId: AppId;
        agentId: AgentId;
    }): Promise<AgentCapabilitiesView>;
}): Promise<AgentCapabilitiesView>;
