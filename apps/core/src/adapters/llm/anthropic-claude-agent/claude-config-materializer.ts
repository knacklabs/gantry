import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { getClaudeProjectDirName } from '../../../shared/myclaw-home.js';
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
  type SkillSource,
} from './claude-skill-materializer.js';

const OPENROUTER_ANTHROPIC_COMPATIBLE_API_URL = 'https://openrouter.ai/api';
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
}

export interface ClaudeRuntimeMaterializationInput {
  groupDir: string;
  cliEntryPoint: string;
  packageRoot: string;
  runId?: string;
  baseTempDir?: string;
  cleanupPolicy?: RuntimeMaterializationCleanupPolicy;
  settings?: Omit<ClaudeSettingsRenderInput, 'cliEntryPoint'>;
  skillSource?: SkillSource;
  enabledSkillIds?: string[];
}

export function applyOpenRouterSdkEnv(env: NodeJS.ProcessEnv): void {
  env.ANTHROPIC_BASE_URL = OPENROUTER_ANTHROPIC_COMPATIBLE_API_URL;
  // secret-scan: empty sentinel prevents ambient first-party keys from winning.
  env.ANTHROPIC_API_KEY = '';
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
    fs.mkdtempSync(path.join(os.tmpdir(), 'myclaw-claude-config-'));
  const cleanupPolicy = input.cleanupPolicy ?? 'delete-after-run';
  const claudeConfigDir = path.join(baseTempDir, 'claude');
  const skillsDir = path.join(claudeConfigDir, 'skills');
  const projectDir = path.join(
    claudeConfigDir,
    'projects',
    getClaudeProjectDirName(input.groupDir),
  );

  try {
    fs.mkdirSync(projectDir, { recursive: true, mode: 0o700 });
    fs.rmSync(skillsDir, { recursive: true, force: true });
    fs.writeFileSync(
      path.join(claudeConfigDir, 'settings.json'),
      stringifyClaudeSettings(
        renderClaudeSettings({
          cliEntryPoint: input.cliEntryPoint,
          ...(input.settings ?? {}),
        }),
      ),
      { mode: 0o600 },
    );
    await materializeClaudeSkills({
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

  return {
    runId,
    baseTempDir,
    claudeConfigDir,
    skillsDir,
    providerSessionRestoreDir: projectDir,
    projectDir,
    cleanupPolicy,
    cleanup: () => {
      if (cleanupPolicy === 'delete-after-run') {
        fs.rmSync(baseTempDir, { recursive: true, force: true });
      }
    },
  };
}
