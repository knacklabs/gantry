import type { SkillCatalogRepository } from '../../../../domain/ports/repositories.js';
import type { AgentSkillBinding, SkillCatalogItem } from '../../../../domain/skills/skills.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
export declare class PostgresSkillCatalogRepository implements SkillCatalogRepository {
    private readonly db;
    constructor(db: CanonicalDb);
    getSkill(id: SkillCatalogItem['id']): Promise<SkillCatalogItem | null>;
    listSkills(input: {
        appId: SkillCatalogItem['appId'];
        agentId?: SkillCatalogItem['agentId'];
        statuses?: SkillCatalogItem['status'][];
    }): Promise<SkillCatalogItem[]>;
    saveSkill(item: SkillCatalogItem): Promise<void>;
    saveAgentSkillBinding(binding: AgentSkillBinding): Promise<void>;
    disableAgentSkillBinding(input: {
        appId: AgentSkillBinding['appId'];
        agentId: AgentSkillBinding['agentId'];
        skillId: AgentSkillBinding['skillId'];
        updatedAt: string;
    }): Promise<AgentSkillBinding | null>;
    listAgentSkillBindings(input: {
        appId: AgentSkillBinding['appId'];
        agentId: AgentSkillBinding['agentId'];
    }): Promise<AgentSkillBinding[]>;
    listAgentSkillBindingsForAgents(input: {
        appId: AgentSkillBinding['appId'];
        agentIds: readonly AgentSkillBinding['agentId'][];
    }): Promise<AgentSkillBinding[]>;
    private listAgentSkillBindingRows;
    listEnabledSkillsForAgent(input: {
        appId: AgentSkillBinding['appId'];
        agentId: AgentSkillBinding['agentId'];
    }): Promise<SkillCatalogItem[]>;
    private mapSkill;
    private mapBinding;
}
