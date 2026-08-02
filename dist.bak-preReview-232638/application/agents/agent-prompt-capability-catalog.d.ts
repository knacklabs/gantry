import type { McpServerRepository, SkillCatalogRepository } from '../../domain/ports/repositories.js';
import type { SemanticCapabilityDefinition } from '../../shared/semantic-capabilities.js';
export type CatalogEntryKind = 'reviewed_capability' | 'skill' | 'mcp_source';
export interface CatalogEntry {
    kind: CatalogEntryKind;
    stableRef: string;
    revision?: string;
    displayName: string;
    description: string;
    category: string;
    accountLabel?: string;
}
export interface AgentPromptCapabilityCatalog {
    schemaVersion: 1;
    readyActions: CatalogEntry[];
    installedSkills: CatalogEntry[];
    connectedMcpSources: CatalogEntry[];
    digest: string;
}
type RepositoryInput<T> = T | (() => T | undefined);
export declare function resolveAgentPromptCapabilityCatalog(input: {
    appId: string;
    agentId: string;
    readySemanticCapabilities?: readonly SemanticCapabilityDefinition[];
    skillRepository?: RepositoryInput<SkillCatalogRepository>;
    mcpServerRepository?: RepositoryInput<McpServerRepository>;
}): Promise<AgentPromptCapabilityCatalog>;
export declare function compareCatalogEntries(left: CatalogEntry, right: CatalogEntry): number;
export {};
