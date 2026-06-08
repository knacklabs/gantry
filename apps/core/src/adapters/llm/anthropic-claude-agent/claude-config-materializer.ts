import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { getClaudeProjectDirName } from '../../../shared/gantry-home.js';
import type {
  RuntimeMaterialization,
  RuntimeMaterializationCleanupPolicy,
} from '../../../domain/runtime/runtime-materialization.js';
import type { ClaudeSettingsRenderInput } from './claude-settings-renderer.js';
import {
  renderClaudeSettings,
  stringifyClaudeSettings,
} from './claude-settings-renderer.js';
import {
  BundledClaudeSkillSource,
  materializeClaudeSkills,
  type ClaudeSkillSourceItem,
  type SkillSource,
} from './claude-skill-materializer.js';

const CLAUDE_MODEL_CREDENTIAL_ENV_KEYS = new Set([
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'NODE_USE_ENV_PROXY',
  'NODE_EXTRA_CA_CERTS',
]);

export interface ClaudeRuntimeMaterialization extends RuntimeMaterialization {
  claudeConfigDir: string;
  skillsDir: string;
  providerSessionRestoreDir: string;
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
  cleanupPolicy?: RuntimeMaterializationCleanupPolicy;
  settings?: Omit<ClaudeSettingsRenderInput, 'cliEntryPoint'>;
  skillSource?: SkillSource;
  enabledSkillIds?: string[];
}

export function projectClaudeModelCredentialEnv(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (
      CLAUDE_MODEL_CREDENTIAL_ENV_KEYS.has(key) &&
      typeof value === 'string'
    ) {
      env[key] = value;
    }
  }
  return env;
}

export async function materializeClaudeRuntime(
  input: ClaudeRuntimeMaterializationInput,
): Promise<ClaudeRuntimeMaterialization> {
  const runId = input.runId ?? randomUUID();
  const ownsBaseTempDir = !input.baseTempDir;
  const baseTempDir =
    input.baseTempDir ??
    fs.mkdtempSync(path.join(os.tmpdir(), 'gantry-claude-config-'));
  const cleanupPolicy = input.cleanupPolicy ?? 'delete-after-run';
  const claudeConfigDir = path.join(baseTempDir, 'claude');
  const skillsDir = path.join(claudeConfigDir, 'skills');
  const projectDir = path.join(
    claudeConfigDir,
    'projects',
    getClaudeProjectDirName(input.groupDir),
  );
  let materializedSkills: ClaudeSkillSourceItem[] = [];
  const claudeSettingsPath = path.join(claudeConfigDir, 'settings.json');

  try {
    fs.mkdirSync(projectDir, { recursive: true, mode: 0o700 });
    fs.rmSync(skillsDir, { recursive: true, force: true });
    fs.writeFileSync(
      claudeSettingsPath,
      stringifyClaudeSettings(
        renderClaudeSettings({
          cliEntryPoint: input.cliEntryPoint,
          ...(input.settings ?? {}),
        }),
      ),
      { mode: 0o600 },
    );
    materializedSkills = await materializeClaudeSkills({
      skillSource:
        input.skillSource ?? new BundledClaudeSkillSource(input.packageRoot),
      skillsDir,
      enabledSkillIds: input.enabledSkillIds,
    });
  } catch (err) {
    if (ownsBaseTempDir) {
      fs.rmSync(baseTempDir, { recursive: true, force: true });
    }
    throw err;
  }

  const protectedFilesystemDenyReadPaths = resolveProtectedFilesystemPaths([
    claudeSettingsPath,
    input.runtimeSettingsPath,
    ...workspaceProtectedPaths(input.groupDir),
    ...(input.globalDir ? workspaceProtectedPaths(input.globalDir) : []),
    path.join(input.packageRoot, '.claude', 'skills'),
    path.join(input.packageRoot, '.codex', 'skills'),
    path.join(input.packageRoot, '.agents', 'skills'),
    ...(input.managedSkillArtifactRoots ?? []),
  ]);
  const protectedFilesystemDenyWritePaths = resolveProtectedFilesystemPaths([
    claudeConfigDir,
    input.runtimeSettingsPath,
    ...workspaceProtectedPaths(input.groupDir),
    ...(input.globalDir ? workspaceProtectedPaths(input.globalDir) : []),
    path.join(input.packageRoot, '.claude', 'skills'),
    path.join(input.packageRoot, '.codex', 'skills'),
    path.join(input.packageRoot, '.agents', 'skills'),
    ...(input.managedSkillArtifactRoots ?? []),
  ]);

  return {
    runId,
    baseTempDir,
    claudeConfigDir,
    skillsDir,
    providerSessionRestoreDir: projectDir,
    projectDir,
    protectedFilesystemPaths: protectedFilesystemDenyWritePaths,
    protectedFilesystemDenyReadPaths,
    protectedFilesystemDenyWritePaths,
    materializedSkills,
    cleanupPolicy,
    cleanup: () => {
      if (cleanupPolicy === 'delete-after-run') {
        fs.rmSync(baseTempDir, { recursive: true, force: true });
      }
    },
  };
}

function workspaceProtectedPaths(root: string): string[] {
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

function resolveProtectedFilesystemPaths(
  paths: Array<string | undefined>,
): string[] {
  return [...new Set(paths.filter((value): value is string => Boolean(value)))]
    .map((value) => path.resolve(value))
    .sort();
}
