import type { SkillCatalogRepository, ToolCatalogRepository } from '../../domain/ports/repositories.js';
import { type SemanticCapabilityDefinition } from '../../shared/semantic-capabilities.js';
import type { CapabilityRuntimeAccess } from '../../shared/capability-runtime-access.js';
export interface AgentToolRuntimeRuleResolutionInput {
    repository: ToolCatalogRepository;
    appId: string;
    agentId: string;
    errorSubject: string;
    skillRepository?: SkillCatalogRepository;
    makeError?: (message: string) => Error;
}
export interface AgentToolRuntimePolicy {
    rules: string[];
    runtimeAccess: CapabilityRuntimeAccess[];
    semanticCapabilities: SemanticCapabilityDefinition[];
    reviewedMcpReadBindings: ReviewedMcpReadBinding[];
}
export interface ReviewedMcpReadBinding {
    capabilityId: string;
    toolPattern: string;
}
export declare function reviewedMcpReadBindingsForRuntimeAccess(input: {
    runtimeAccess?: readonly CapabilityRuntimeAccess[];
    semanticCapabilities?: readonly SemanticCapabilityDefinition[];
}): ReviewedMcpReadBinding[];
export declare function resolveAgentToolRuntimeRules(input: AgentToolRuntimeRuleResolutionInput): Promise<string[]>;
export declare function resolveAgentToolRuntimePolicy(input: AgentToolRuntimeRuleResolutionInput): Promise<AgentToolRuntimePolicy>;
export declare function validateAgentToolRuntimeRules(input: {
    rules: readonly string[];
    errorSubject: string;
    allowProjectedThirdPartyMcpTools?: boolean;
    makeError?: (message: string) => Error;
}): void;
