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
