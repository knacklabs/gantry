import type { Job } from '../../domain/types.js';
import type { SkillCatalogRepository, ToolCatalogRepository } from '../../domain/ports/repositories.js';
import type { CapabilityRuntimeAccess } from '../../shared/capability-runtime-access.js';
export interface JobToolPolicyResolution {
    inheritedTools: string[];
    effectiveAllowedTools: string[];
    runtimeAccess: CapabilityRuntimeAccess[];
}
export declare function agentIdForJobWorkspaceKey(workspaceKey: string): string;
export declare function resolveJobToolPolicy(input: {
    job: Job;
    appId?: string;
    agentId?: string;
    toolRepository?: ToolCatalogRepository;
    skillRepository?: SkillCatalogRepository;
}): Promise<JobToolPolicyResolution>;
export declare function resolveAgentToolBindings(input: {
    repository?: ToolCatalogRepository;
    skillRepository?: SkillCatalogRepository;
    appId: string;
    agentId: string;
}): Promise<string[]>;
export declare function resolveAgentToolBindingPolicy(input: {
    repository?: ToolCatalogRepository;
    skillRepository?: SkillCatalogRepository;
    appId: string;
    agentId: string;
}): Promise<{
    rules: string[];
    runtimeAccess: CapabilityRuntimeAccess[];
}>;
