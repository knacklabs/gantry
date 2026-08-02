import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type { SkillCatalogRepository } from '../../domain/ports/repositories.js';
import type { SkillCatalogItem } from '../../domain/skills/skills.js';
export interface ResolvedSkillReferences {
    skills: Map<string, SkillCatalogItem>;
    errors: Map<string, string>;
}
export declare function selectedSkillsFromResolvedSkillReferences(references: readonly string[], resolved: ResolvedSkillReferences): SkillCatalogItem[];
export declare function resolveConfiguredSkillReferences(input: {
    repository: SkillCatalogRepository;
    appId: AppId;
    agentId: AgentId;
    references: readonly string[];
}): Promise<ResolvedSkillReferences>;
