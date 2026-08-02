import type { AgentId } from '../../domain/agent/agent.js';
import type { AppId } from '../../domain/app/app.js';
import type { SkillArtifactStore } from '../../domain/ports/skill-artifact-store.js';
import type { SkillCatalogRepository } from '../../domain/ports/repositories.js';
import type { AgentSkillBinding, SkillCatalogItem, SkillId, SkillStatus } from '../../domain/skills/skills.js';
export declare class SkillService {
    private readonly skills;
    private readonly artifacts;
    constructor(skills: SkillCatalogRepository, artifacts: SkillArtifactStore);
    installSkill(input: {
        appId: AppId;
        agentId?: AgentId;
        name?: string;
        description?: string;
        fallbackName?: string;
        requiredEnvVars?: string[];
        createdBy?: string;
        assets: Array<{
            path: string;
            contentType?: string;
            content: Uint8Array;
        }>;
        now?: string;
    }): Promise<SkillCatalogItem>;
    listSkills(input: {
        appId: AppId;
        agentId?: AgentId;
        statuses?: SkillStatus[];
    }): Promise<SkillCatalogItem[]>;
    bindSkillToAgent(input: {
        appId: AppId;
        agentId: AgentId;
        skillId: SkillId;
        now?: string;
    }): Promise<AgentSkillBinding>;
    private disableActiveMaterializationCollisions;
    unbindSkillFromAgent(input: {
        appId: AppId;
        agentId: AgentId;
        skillId: SkillId;
        now?: string;
    }): Promise<AgentSkillBinding | null>;
    rollbackInstalledSkillBinding(input: {
        appId: AppId;
        agentId: AgentId;
        skillId: SkillId;
        now?: string;
    }): Promise<void>;
    resolveLocalSkillsForAgent(input: {
        appId: AppId;
        agentId: AgentId;
    }): Promise<SkillCatalogItem[]>;
    installMaterializationCollisionForAgent(input: {
        appId: AppId;
        agentId: AgentId;
        name: string;
        skillId?: SkillId;
    }): Promise<string | null>;
    requireSkill(appId: AppId, skillId: SkillId): Promise<SkillCatalogItem>;
    private findExistingSkillByMaterializationKey;
    private disableInstalledMaterializationDuplicates;
}
