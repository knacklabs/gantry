import type { RuntimeMaterialization } from '../../../domain/runtime/runtime-materialization.js';
import type { ClaudeSettingsRenderInput } from './claude-settings-renderer.js';
import { type ClaudeSkillSourceItem, type SkillSource } from './claude-skill-materializer.js';
export interface ClaudeRuntimeMaterialization extends RuntimeMaterialization {
    claudeConfigDir: string;
    skillsDir: string;
    projectDir: string;
    protectedFilesystemPaths: string[];
    protectedFilesystemDenyReadPaths: string[];
    protectedFilesystemDenyWritePaths: string[];
    materializedSkills: ClaudeSkillSourceItem[];
}
export interface ClaudeRuntimeMaterializationInput {
    groupDir: string;
    globalDir?: string;
    cliEntryPoint: string;
    packageRoot: string;
    runtimeSettingsPath?: string;
    managedSkillArtifactRoots?: string[];
    runId?: string;
    baseTempDir?: string;
    settings?: Omit<ClaudeSettingsRenderInput, 'cliEntryPoint'>;
    skillSource?: SkillSource;
    enabledSkillIds?: string[];
}
export declare function projectClaudeModelCredentialEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export declare function materializeClaudeRuntime(input: ClaudeRuntimeMaterializationInput): Promise<ClaudeRuntimeMaterialization>;
