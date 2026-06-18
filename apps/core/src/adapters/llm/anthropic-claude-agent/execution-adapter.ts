import fs from 'fs';
import path from 'path';

import { ARTIFACTS_DIR, RUNTIME_SETTINGS_PATH } from '../../../config/index.js';
import type {
  AgentExecutionAdapter,
  AgentExecutionAdapterPrepareInput,
  AgentExecutionProviderId,
  PreparedAgentExecution,
} from '../../../application/agent-execution/agent-execution-adapter.js';
import {
  materializeClaudeRuntime,
  projectClaudeModelCredentialEnv,
} from './claude-config-materializer.js';
import { validateModelCredentialProjectionForEntry } from './model-provider-credential-validation.js';
import {
  ArtifactClaudeSkillSource,
  BundledGantrySkillSource,
  CompositeSkillSource,
  RUNTIME_GANTRY_BROWSER_SKILL_ID,
  RuntimeInstalledGantryBrowserSkillSource,
  type SkillSource,
} from './claude-skill-materializer.js';
import { skillActionSemanticCapability } from '../../../domain/skills/skill-action-permissions.js';
import {
  GANTRY_CLAUDE_SDK_SKILLS_ENV,
  claudeSdkSkillNamesForMaterializedSkills,
} from './native-sdk-skills.js';

const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';
const ANTHROPIC_MODEL_ENV = 'ANTHROPIC_MODEL';
const GANTRY_EFFECTIVE_MODEL_SOURCE_ENV = 'GANTRY_EFFECTIVE_MODEL_SOURCE';
const GANTRY_MCP_SERVER_PATH_ENV = 'GANTRY_MCP_SERVER_PATH';
const GANTRY_SKILL_ACTIONS_ENV = 'GANTRY_SKILL_ACTIONS_JSON';

function claudeCodeToolTempDirLeaf(): string {
  return process.platform === 'win32'
    ? 'claude'
    : `claude-${process.getuid?.() ?? 0}`;
}

export class AnthropicClaudeAgentExecutionAdapter implements AgentExecutionAdapter {
  readonly id = 'anthropic:claude-agent-sdk' as AgentExecutionProviderId;

  isMissingProviderSessionError(error: string | undefined): boolean {
    return /\bNo conversation found with session ID\b/i.test(error ?? '');
  }

  async prepare(
    input: AgentExecutionAdapterPrepareInput,
  ): Promise<PreparedAgentExecution> {
    const runnerPath = path.join(
      input.hostRuntime.runnerDistDir,
      '..',
      'adapters',
      'llm',
      'anthropic-claude-agent',
      'runner',
      'index.js',
    );
    if (!fs.existsSync(runnerPath)) {
      throw new Error(
        'Host runtime is missing required Anthropic execution adapter runner files. Reinstall Gantry from npm and restart.',
      );
    }

    this.validateCredentialProjection(input);

    const packageRoot = input.packageRootFromRunner(runnerPath);
    const relativeRunnerPath = path.relative(packageRoot, runnerPath);
    if (
      relativeRunnerPath.startsWith('..') ||
      path.isAbsolute(relativeRunnerPath)
    ) {
      throw new Error(
        'Anthropic execution adapter runner path escaped the Gantry package root.',
      );
    }
    const selectedSkillIds = this.selectedSkillIds(input);
    const skillSources = this.skillSources(input, packageRoot);
    const materialization = await materializeClaudeRuntime({
      groupDir: input.groupDir,
      baseTempDir: path.join(input.groupDir, '.llm-runtime'),
      cleanupPolicy: 'retain-for-debug',
      cliEntryPoint: path.join(packageRoot, 'dist', 'cli', 'index.js'),
      packageRoot,
      runtimeSettingsPath: RUNTIME_SETTINGS_PATH,
      managedSkillArtifactRoots: [path.join(ARTIFACTS_DIR, 'skills')],
      skillSource: new CompositeSkillSource(skillSources),
      enabledSkillIds: selectedSkillIds,
      settings: {
        model: input.effectiveModel,
      },
    });

    const modelCredentialEnv = projectClaudeModelCredentialEnv(
      input.modelCredentialProjection.env,
    );
    const serializedModelCredentialEnv = Object.fromEntries(
      Object.entries(modelCredentialEnv).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );

    const env: NodeJS.ProcessEnv = {
      [CLAUDE_CONFIG_DIR_ENV]: materialization.claudeConfigDir,
      [GANTRY_CLAUDE_SDK_SKILLS_ENV]: JSON.stringify(
        claudeSdkSkillNamesForMaterializedSkills(
          materialization.materializedSkills ?? [],
        ),
      ),
      [GANTRY_MCP_SERVER_PATH_ENV]: path.join(
        input.hostRuntime.runnerDistDir,
        'mcp',
        'stdio.js',
      ),
    };
    if (input.effectiveModel) {
      env[ANTHROPIC_MODEL_ENV] = input.effectiveModel;
      env[GANTRY_EFFECTIVE_MODEL_SOURCE_ENV] = 'runtime';
    }
    const attachedSkillSourceIds = new Set(selectedSkillIds);
    const skillActionDefinitions = (materialization.materializedSkills ?? [])
      .filter(
        (skill) =>
          !attachedSkillSourceIds || attachedSkillSourceIds.has(skill.id),
      )
      .flatMap((skill) =>
        (skill.actionPermissions ?? []).map((action) =>
          skillActionSemanticCapability({
            skillId: skill.id,
            skillName: skill.name,
            action,
          }),
        ),
      );
    if (skillActionDefinitions.length > 0) {
      env[GANTRY_SKILL_ACTIONS_ENV] = JSON.stringify(skillActionDefinitions);
    }

    const runnerInputPatch: PreparedAgentExecution['runnerInputPatch'] = {};
    if (Object.keys(serializedModelCredentialEnv).length > 0) {
      runnerInputPatch.modelCredentialEnv = serializedModelCredentialEnv;
    }
    runnerInputPatch.semanticCapabilities = [
      ...(input.input.semanticCapabilities ?? []),
      ...skillActionDefinitions,
    ];

    return {
      providerId: this.id,
      runnerPath,
      runnerArgs: [runnerPath],
      runtimeConfigDir: materialization.claudeConfigDir,
      runnerInputPatch,
      sandboxRuntime: {
        toolTempDirLeaf: claudeCodeToolTempDirLeaf(),
        tempEnv: (runnerTempDir) => ({
          CLAUDE_CODE_TMPDIR: runnerTempDir,
          CLAUDE_TMPDIR: runnerTempDir,
        }),
      },
      env,
      protectedFilesystemPaths: materialization.protectedFilesystemPaths,
      protectedFilesystemDenyReadPaths:
        materialization.protectedFilesystemDenyReadPaths,
      protectedFilesystemDenyWritePaths:
        materialization.protectedFilesystemDenyWritePaths,
      runtimeDetails: [
        `executionProvider=${this.id}`,
        `runner=${runnerPath}`,
        `configDir=${materialization.claudeConfigDir}`,
      ],
      cleanup: () => materialization.cleanup(),
    };
  }

  private skillSources(
    input: AgentExecutionAdapterPrepareInput,
    packageRoot: string,
  ): SkillSource[] {
    const skillSources: SkillSource[] = [
      new BundledGantrySkillSource(packageRoot),
    ];
    if (input.browserIpcEnabled) {
      skillSources.push(new RuntimeInstalledGantryBrowserSkillSource());
    }
    if (
      input.options?.skillRepository &&
      input.options.skillArtifactStore &&
      input.options.skillContext?.appId &&
      input.options.skillContext.agentId
    ) {
      skillSources.push(
        new ArtifactClaudeSkillSource(
          input.options.skillRepository,
          input.options.skillArtifactStore,
          {
            appId: input.options.skillContext.appId as never,
            agentId: input.options.skillContext.agentId as never,
          },
        ),
      );
    }
    return skillSources;
  }

  private selectedSkillIds(input: AgentExecutionAdapterPrepareInput): string[] {
    const selected = new Set(input.input.attachedSkillSourceIds ?? []);
    if (input.browserIpcEnabled) {
      selected.add(RUNTIME_GANTRY_BROWSER_SKILL_ID);
    }
    return [...selected].sort();
  }

  private validateCredentialProjection(
    input: AgentExecutionAdapterPrepareInput,
  ): void {
    const { effectiveModelEntry, modelCredentialProjection } = input;
    if (!effectiveModelEntry) return;
    validateModelCredentialProjectionForEntry({
      model: effectiveModelEntry,
      projection: modelCredentialProjection,
    });
  }
}

export function createAnthropicClaudeAgentExecutionAdapter(): AgentExecutionAdapter {
  return new AnthropicClaudeAgentExecutionAdapter();
}
