import type { AppId } from '../domain/app/app.js';
import type { AgentId } from '../domain/agent/agent.js';
import type { SkillArtifactBundle, SkillArtifactStore } from '../domain/ports/skill-artifact-store.js';
import type { SkillCatalogRepository } from '../domain/ports/repositories.js';
import { type AgentSkillBinding, type SkillCatalogItem } from '../domain/skills/skills.js';
export { withSkillMaterializationLock } from '../shared/skill-install-lock.js';
export type InstalledSkillAsset = {
    path: string;
    contentType?: string;
    content: Uint8Array;
};
export type ApprovedCommandSkillInstallResult = {
    skills: SkillCatalogItem[];
    failed: Array<{
        name: string;
        reason: string;
    }>;
    skippedBeyondLimit: boolean;
    installed: Array<{
        skill: SkillCatalogItem;
        assets: InstalledSkillAsset[];
    }>;
};
export declare const MAX_SKILLS_PER_INSTALL_COMMAND = 25;
export declare const MAX_SKILL_DISCOVERY_DIRECTORIES = 500;
export type InstalledSkillSnapshot = {
    skill: SkillCatalogItem;
    agentId: AgentId;
    bundle: SkillArtifactBundle;
    binding?: AgentSkillBinding;
};
export declare function skillInstallCommandReceipt(result: ApprovedCommandSkillInstallResult): string;
export declare function safeInstallerEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export declare function boundedSkillInstallFailureReason(err: unknown): string;
export declare function discoverInstalledSkillRoots(stagingDir: string): {
    roots: string[];
    skippedBeyondLimit: boolean;
};
export declare function collectInstalledSkillAssets(root: string): InstalledSkillAsset[];
export declare function skillNameForReceipt(assets: InstalledSkillAsset[], fallback: string): string;
export declare function snapshotInstalledSkill(input: {
    appId: AppId;
    agentId: AgentId;
    name: string;
    skills: SkillCatalogRepository;
    artifacts: SkillArtifactStore;
}): Promise<InstalledSkillSnapshot | undefined>;
export declare function reportUnattemptedSkillRoots(result: ApprovedCommandSkillInstallResult, roots: string[], currentRoot: string): void;
export declare function rollbackFreshInstallBinding(input: {
    reason: string;
    syncAttempted: boolean;
    rollbackBinding: () => Promise<void>;
    isBindingActive: () => Promise<boolean>;
    sync: () => Promise<void>;
}): Promise<{
    reason: string;
    stopAfterFailure: boolean;
    keepAsInstalled: boolean;
}>;
export declare function rollbackInstalledSkillReplacement(input: {
    reason: string;
    snapshot: InstalledSkillSnapshot;
    attemptedAssets: InstalledSkillAsset[];
    skills: SkillCatalogRepository;
    artifacts: SkillArtifactStore;
    syncAfterRestore: () => Promise<void>;
}): Promise<{
    reason: string;
    stopAfterFailure: boolean;
}>;
export declare function installedSkillContext(installed: Array<{
    skill: SkillCatalogItem;
    assets: InstalledSkillAsset[];
}>): {
    additionalSkills?: {
        skill: {
            id: import("../domain/skills/skills.js").SkillId;
            name: string;
            description: string | undefined;
            requiredEnvVars: string[];
        };
        files: {
            content: string;
            contentType?: string | undefined;
            path: string;
        }[];
    }[] | undefined;
    requiredEnvVars: string[];
    skill: {
        id: import("../domain/skills/skills.js").SkillId;
        name: string;
        description: string | undefined;
        requiredEnvVars: string[];
    };
    files: {
        content: string;
        contentType?: string | undefined;
        path: string;
    }[];
    type: string;
    activation: string;
};
