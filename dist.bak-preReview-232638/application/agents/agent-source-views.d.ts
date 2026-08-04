import type { SkillCatalogRepository } from '../../domain/ports/repositories.js';
import type { AgentMcpServerBinding } from '../../domain/mcp/mcp-servers.js';
import type { AgentSkillBinding } from '../../domain/skills/skills.js';
import type { AgentToolSource } from '../../domain/tools/tools.js';
export interface ReadableSkillSource {
    name?: string;
    id: string;
}
export interface ReadableToolSource {
    id: string;
    kind: string;
    version?: string;
}
export declare function readableSkillSources(input: {
    skillBindings: readonly AgentSkillBinding[];
    repository: SkillCatalogRepository;
}): Promise<ReadableSkillSource[]>;
export declare function readableToolSources(sources: readonly AgentToolSource[]): ReadableToolSource[];
export interface AgentSourcesProjection {
    skills: ReadableSkillSource[];
    mcpServers: Array<{
        id: string;
        tools?: string[];
    }>;
    tools: ReadableToolSource[];
}
export declare function buildAgentSources(input: {
    configuredSkillSources: ReadableSkillSource[];
    mcpBindings: readonly AgentMcpServerBinding[];
    toolSources: readonly AgentToolSource[];
}): AgentSourcesProjection;
