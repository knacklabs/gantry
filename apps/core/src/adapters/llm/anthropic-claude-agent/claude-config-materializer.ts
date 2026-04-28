import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type {
  ProviderArtifactStore,
  ProviderSessionArtifactContext,
} from '../../../domain/ports/provider-artifact-store.js';
import type { ProviderSessionArtifact } from '../../../domain/sessions/provider-session-artifact.js';
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
  sessionId?: string;
  runId?: string;
  baseTempDir?: string;
  cleanupPolicy?: RuntimeMaterializationCleanupPolicy;
  settings?: Omit<ClaudeSettingsRenderInput, 'cliEntryPoint'>;
  skillSource?: SkillSource;
  enabledSkillIds?: string[];
  providerArtifactStore?: ProviderArtifactStore;
  artifactContext?: ProviderSessionArtifactContext;
}

function asText(content: Uint8Array | string): string {
  return typeof content === 'string'
    ? content
    : Buffer.from(content).toString('utf-8');
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
    await restoreClaudeProviderArtifact({
      sessionId: input.sessionId,
      providerArtifactStore: input.providerArtifactStore,
      artifactContext: input.artifactContext,
      projectDir,
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

async function restoreClaudeProviderArtifact(input: {
  sessionId?: string;
  providerArtifactStore?: ProviderArtifactStore;
  artifactContext?: ProviderSessionArtifactContext;
  projectDir: string;
}): Promise<void> {
  const latest = await resolveLatestClaudeArtifact(input);
  if (!latest || !input.providerArtifactStore || !input.sessionId) return;
  const restored = await input.providerArtifactStore.getArtifact(latest);
  fs.writeFileSync(
    path.join(input.projectDir, `${input.sessionId}.jsonl`),
    asText(restored),
    { mode: 0o600 },
  );
}

async function resolveLatestClaudeArtifact(input: {
  sessionId?: string;
  providerArtifactStore?: ProviderArtifactStore;
  artifactContext?: ProviderSessionArtifactContext;
}): Promise<ProviderSessionArtifact | undefined> {
  if (
    !input.sessionId ||
    !input.providerArtifactStore ||
    !input.artifactContext
  ) {
    return undefined;
  }
  if (input.artifactContext.providerSessionId) {
    return input.providerArtifactStore.getLatestArtifact({
      providerSessionId: input.artifactContext.providerSessionId as never,
      provider: input.artifactContext.provider ?? 'anthropic',
      artifactKind: 'claude-jsonl',
    });
  }
  return input.providerArtifactStore.getLatestArtifact({
    agentSessionId: input.artifactContext.agentSessionId as never,
    provider: input.artifactContext.provider ?? 'anthropic',
    artifactKind: 'claude-jsonl',
  });
}

export async function captureClaudeArtifacts(input: {
  providerArtifactStore?: ProviderArtifactStore;
  artifactContext?: ProviderSessionArtifactContext;
  providerSessionId?: string;
  sessionId?: string;
  projectDir: string;
}): Promise<{ latestArtifactId?: string }> {
  if (
    !input.providerArtifactStore ||
    !input.artifactContext ||
    !input.providerSessionId ||
    !input.sessionId
  ) {
    return {};
  }

  const transcriptPath = path.join(
    input.projectDir,
    `${input.sessionId}.jsonl`,
  );
  if (!fs.existsSync(transcriptPath)) return {};
  const provider = input.artifactContext.provider ?? 'anthropic';

  const artifact = await input.providerArtifactStore.putArtifact({
    appId: input.artifactContext.appId as never,
    agentId: input.artifactContext.agentId as never,
    agentSessionId: input.artifactContext.agentSessionId as never,
    providerSessionId: input.providerSessionId as never,
    provider,
    artifactKind: 'claude-jsonl',
    content: fs.readFileSync(transcriptPath),
    contentType: 'application/x-jsonlines',
    metadata: {
      externalSessionId: input.sessionId,
      source: 'claude-sdk',
    },
  });

  const indexPath = path.join(input.projectDir, 'sessions-index.json');
  if (fs.existsSync(indexPath)) {
    await input.providerArtifactStore.putArtifact({
      appId: input.artifactContext.appId as never,
      agentId: input.artifactContext.agentId as never,
      agentSessionId: input.artifactContext.agentSessionId as never,
      providerSessionId: input.providerSessionId as never,
      provider,
      artifactKind: 'claude-session-index',
      content: fs.readFileSync(indexPath),
      contentType: 'application/json',
      metadata: {
        externalSessionId: input.sessionId,
        source: 'claude-sdk',
      },
    });
  }

  return { latestArtifactId: artifact.id };
}
