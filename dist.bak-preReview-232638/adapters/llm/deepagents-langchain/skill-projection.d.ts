import type { SkillArtifactStore } from '../../../domain/ports/skill-artifact-store.js';
import type { SkillCatalogRepository } from '../../../domain/ports/repositories.js';
import type { DeepAgentSkillProjection } from '../../../application/agent-execution/agent-execution-adapter.js';
export declare function resolveDeepAgentSkillProjection(input: {
    selectedSkillIds?: readonly string[];
    skillRepository?: SkillCatalogRepository;
    skillArtifactStore?: SkillArtifactStore;
    skillContext?: {
        appId: string;
        agentId: string;
    };
    nowIso?: () => string;
}): Promise<DeepAgentSkillProjection | undefined>;
export declare function reconcileDeepAgentSkillFiles(input: {
    currentFiles?: DeepAgentSkillProjection['files'];
    checkpointTuple?: unknown;
}): Record<string, DeepAgentSkillProjection['files'][string] | null> | undefined;
