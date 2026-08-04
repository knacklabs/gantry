import type { AgentId } from '../../../domain/agent/agent.js';
import type { AppId } from '../../../domain/app/app.js';
import type { SkillArtifactStore } from '../../../domain/ports/skill-artifact-store.js';
import type { SkillCatalogRepository } from '../../../domain/ports/repositories.js';
import { type SkillActionPermission } from '../../../domain/skills/skill-action-permissions.js';
export interface ClaudeSkillSourceItem {
    id: string;
    name: string;
    sourceType?: 'bundled' | 'artifact' | 'runtime';
    sourceDir?: string;
    assets?: Array<{
        path: string;
        content: Uint8Array;
    }>;
    contentHash?: string;
    actionPermissions?: SkillActionPermission[];
    materializedName?: string;
    enabled: boolean;
}
export interface SkillSource {
    listSkills(input?: {
        enabledSkillIds?: string[];
    }): Promise<ClaudeSkillSourceItem[]>;
}
export declare const GANTRY_BUNDLED_SKILL_IDS: readonly ["gantry-admin"];
export declare class BundledGantrySkillSource implements SkillSource {
    private readonly packageRoot;
    constructor(packageRoot: string);
    listSkills(input?: {
        enabledSkillIds?: string[];
    }): Promise<ClaudeSkillSourceItem[]>;
}
export declare class ArtifactClaudeSkillSource implements SkillSource {
    private readonly skills;
    private readonly artifacts;
    private readonly context;
    constructor(skills: SkillCatalogRepository, artifacts: SkillArtifactStore, context: {
        appId: AppId;
        agentId: AgentId;
    });
    listSkills(input?: {
        enabledSkillIds?: string[];
    }): Promise<ClaudeSkillSourceItem[]>;
}
export declare const RUNTIME_GANTRY_BROWSER_SKILL_ID = "gantry-browser";
export declare const RUNTIME_GANTRY_BROWSER_SKILL_VERSION = "gantry-runtime-v1";
export declare class RuntimeInstalledGantryBrowserSkillSource implements SkillSource {
    listSkills(input?: {
        enabledSkillIds?: string[];
    }): Promise<ClaudeSkillSourceItem[]>;
}
export declare class CompositeSkillSource implements SkillSource {
    private readonly sources;
    constructor(sources: SkillSource[]);
    listSkills(input?: {
        enabledSkillIds?: string[];
    }): Promise<ClaudeSkillSourceItem[]>;
}
export declare function materializeClaudeSkills(input: {
    skillSource: SkillSource;
    skillsDir: string;
    enabledSkillIds?: string[];
}): Promise<ClaudeSkillSourceItem[]>;
