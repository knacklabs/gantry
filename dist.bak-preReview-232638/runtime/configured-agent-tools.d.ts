import type { SkillCatalogRepository, ToolCatalogRepository } from '../domain/ports/repositories.js';
import type { CapabilityRuntimeAccess } from '../shared/capability-runtime-access.js';
import type { SemanticCapabilityDefinition } from '../shared/semantic-capabilities.js';
export interface ConfiguredAgentToolPolicy {
    toolPolicyRules: string[] | undefined;
    runtimeAccess: CapabilityRuntimeAccess[];
    semanticCapabilities: SemanticCapabilityDefinition[];
}
export declare function resolveConfiguredAllowedTools(input: {
    repository?: ToolCatalogRepository;
    skillRepository?: SkillCatalogRepository;
    appId: string;
    agentId: string;
}): Promise<string[] | undefined>;
export declare function resolveConfiguredToolPolicy(input: {
    repository?: ToolCatalogRepository;
    skillRepository?: SkillCatalogRepository;
    appId: string;
    agentId: string;
}): Promise<ConfiguredAgentToolPolicy>;
