import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type { McpServerDefinition } from '../../domain/mcp/mcp-servers.js';
import type { AgentRepository, McpServerRepository, SkillCatalogRepository, ToolCatalogRepository } from '../../domain/ports/repositories.js';
import type { SkillCatalogItem } from '../../domain/skills/skills.js';
import type { ToolCatalogItem } from '../../domain/tools/tools.js';
import { type AgentToolAccessView } from '../../shared/tool-access-view.js';
import { type ReadableSkillSource, type ReadableToolSource } from './agent-source-views.js';
import { type AgentAccessSummary } from './agent-access-summary.js';
export interface CapabilityCatalogView {
    tools: ToolCatalogItem[];
    skills: SkillCatalogItem[];
    mcpServers: McpServerDefinition[];
}
export interface AgentCapabilitiesView {
    agentId: AgentId;
    sources: {
        skills: ReadableSkillSource[];
        mcpServers: Array<{
            id: string;
            tools?: string[];
        }>;
        tools: ReadableToolSource[];
    };
    capabilities: Array<{
        id: string;
        version: string;
    }>;
    toolAccess: AgentToolAccessView;
    summary: AgentAccessSummary;
    updatedAt: string;
}
export interface AgentSourcesView {
    agentId: AgentId;
    sources: AgentCapabilitiesView['sources'];
    updatedAt: string;
}
export declare class AgentCapabilityAdministrationService {
    private readonly repositories;
    private readonly clock;
    constructor(repositories: {
        agents: AgentRepository;
        tools: ToolCatalogRepository;
        skills: SkillCatalogRepository;
        mcpServers: McpServerRepository;
    }, clock?: {
        now(): string;
    });
    listCatalog(appId: AppId): Promise<CapabilityCatalogView>;
    getCapabilities(input: {
        appId: AppId;
        agentId: AgentId;
    }): Promise<AgentCapabilitiesView>;
    replaceCapabilities(input: {
        appId: AppId;
        agentId: AgentId;
        capabilities: Array<{
            id: string;
            version: string;
        }>;
    }): Promise<AgentCapabilitiesView>;
    getSources(input: {
        appId: AppId;
        agentId: AgentId;
    }): Promise<AgentSourcesView>;
    replaceAccessDocument(input: {
        appId: AppId;
        agentId: AgentId;
        sources: AgentCapabilitiesView['sources'];
        capabilities: Array<{
            id: string;
            version: string;
        }>;
    }): Promise<AgentCapabilitiesView>;
    replaceSources(input: {
        appId: AppId;
        agentId: AgentId;
        sources: AgentCapabilitiesView['sources'];
    }): Promise<AgentSourcesView>;
    private listAgentToolSources;
    private replaceAgentToolSources;
    private requireAgent;
    private requireSelectableTools;
    private requireInstalledSkills;
    private requireActiveMcpServers;
}
