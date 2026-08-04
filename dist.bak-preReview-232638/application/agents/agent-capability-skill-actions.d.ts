import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type { SkillCatalogRepository } from '../../domain/ports/repositories.js';
import type { AgentSkillBinding } from '../../domain/skills/skills.js';
import type { ToolCatalogItem } from '../../domain/tools/tools.js';
import { type SemanticCapabilityDefinition } from '../../shared/semantic-capabilities.js';
export declare function skillActionDefinitionsForAgent(input: {
    appId: AppId;
    agentId: AgentId;
    skillRepository: SkillCatalogRepository;
}): Promise<Record<string, SemanticCapabilityDefinition>>;
export declare function skillActionDefinitionsForBindings(input: {
    appId: AppId;
    skillBindings: readonly AgentSkillBinding[];
    skillRepository: SkillCatalogRepository;
}): Promise<Record<string, SemanticCapabilityDefinition>>;
export declare function canonicalToolReferenceForView(reference: string, options?: {
    semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>;
}): string[];
export declare function capabilityFromCanonicalToolReference(reference: string, tool: ToolCatalogItem | undefined, semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>): Array<{
    id: string;
    version: string;
}>;
export declare function buildSelectedCapabilities(configuredToolEntries: Array<{
    reference: string;
    tool: ToolCatalogItem;
}>, semanticCapabilityDefinitions?: Record<string, SemanticCapabilityDefinition>): Array<{
    id: string;
    version: string;
}>;
