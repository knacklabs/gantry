import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { getClaudeProjectDirName } from '../../../shared/gantry-home.js';
import { renderClaudeSettings, stringifyClaudeSettings, } from './claude-settings-renderer.js';
import { BundledGantrySkillSource, materializeClaudeSkills, } from './claude-skill-materializer.js';
const CLAUDE_MODEL_CREDENTIAL_ENV_KEYS = new Set([
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'NODE_EXTRA_CA_CERTS',
]);
export function projectClaudeModelCredentialEnv(source) {
    const env = {};
    for (const [key, value] of Object.entries(source)) {
        if (CLAUDE_MODEL_CREDENTIAL_ENV_KEYS.has(key) &&
            typeof value === 'string') {
            env[key] = value;
        }
    }
    return env;
}
export async function materializeClaudeRuntime(input) {
    const runId = input.runId ?? randomUUID();
    const cleanupBaseDir = Boolean(input.baseTempDir);
    const baseTempDir = input.baseTempDir ?? createDefaultBaseDir(input.groupDir);
    const claudeConfigDir = path.join(baseTempDir, 'claude');
    const skillsDir = path.join(claudeConfigDir, 'skills');
    const projectDir = path.join(claudeConfigDir, 'projects', getClaudeProjectDirName(input.groupDir));
    let materializedSkills = [];
    const claudeSettingsPath = path.join(claudeConfigDir, 'settings.json');
    try {
        fs.mkdirSync(projectDir, { recursive: true, mode: 0o700 });
        fs.rmSync(skillsDir, { recursive: true, force: true });
        fs.writeFileSync(claudeSettingsPath, stringifyClaudeSettings(renderClaudeSettings({
            cliEntryPoint: input.cliEntryPoint,
            ...(input.settings ?? {}),
        })), { mode: 0o600 });
        materializedSkills = await materializeClaudeSkills({
            skillSource: input.skillSource ?? new BundledGantrySkillSource(input.packageRoot),
            skillsDir,
            enabledSkillIds: input.enabledSkillIds,
        });
    }
    catch (err) {
        if (cleanupBaseDir) {
            fs.rmSync(baseTempDir, { recursive: true, force: true });
        }
        throw err;
    }
    const protectedFilesystemDenyReadPaths = resolveProtectedFilesystemPaths([
        claudeSettingsPath,
        input.runtimeSettingsPath,
        ...workspaceProtectedPaths(input.groupDir),
        ...(input.globalDir ? workspaceProtectedPaths(input.globalDir) : []),
        path.join(input.packageRoot, '.codex', 'skills'),
        path.join(input.packageRoot, '.agents', 'skills'),
        ...(input.managedSkillArtifactRoots ?? []),
    ]);
    const protectedFilesystemDenyWritePaths = resolveProtectedFilesystemPaths([
        claudeConfigDir,
        input.runtimeSettingsPath,
        ...workspaceProtectedPaths(input.groupDir),
        ...(input.globalDir ? workspaceProtectedPaths(input.globalDir) : []),
        path.join(input.packageRoot, '.codex', 'skills'),
        path.join(input.packageRoot, '.agents', 'skills'),
        ...(input.managedSkillArtifactRoots ?? []),
    ]);
    return {
        runId,
        baseTempDir,
        claudeConfigDir,
        skillsDir,
        projectDir,
        protectedFilesystemPaths: protectedFilesystemDenyWritePaths,
        protectedFilesystemDenyReadPaths,
        protectedFilesystemDenyWritePaths,
        materializedSkills,
        cleanup: () => {
            if (cleanupBaseDir) {
                fs.rmSync(baseTempDir, { recursive: true, force: true });
            }
        },
    };
}
function createDefaultBaseDir(groupDir) {
    const runtimeDir = path.join(groupDir, '.llm-runtime');
    fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    return runtimeDir;
}
function workspaceProtectedPaths(root) {
    const providerDir = ['.clau', 'de'].join('');
    return [
        path.join(root, '.mcp.json'),
        path.join(root, 'mcp.json'),
        path.join(root, providerDir, 'settings.json'),
        path.join(root, providerDir, 'settings.local.json'),
        path.join(root, providerDir, 'mcp'),
        path.join(root, providerDir, 'skills'),
        path.join(root, 'skills'),
    ];
}
function resolveProtectedFilesystemPaths(paths) {
    return [...new Set(paths.filter((value) => Boolean(value)))]
        .map((value) => path.resolve(value))
        .sort();
}
