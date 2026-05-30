import fs from 'fs';
import path from 'path';

import { ARTIFACTS_DIR, RUNTIME_SETTINGS_PATH } from '../../../config/index.js';
import { logger } from '../../../infrastructure/logging/logger.js';
import {
  CHILD_RUNNER_FROM_SOURCE_ENV,
  CHILD_RUNNER_INSPECT_PORT_ENV,
  buildChildRunnerLaunch,
} from './child-runner-launch.js';
import type {
  AgentExecutionAdapter,
  AgentExecutionAdapterPrepareInput,
  AgentExecutionProviderId,
  PreparedAgentExecution,
} from '../../../application/agent-execution/agent-execution-adapter.js';
import {
  applyOpenRouterSdkEnv,
  materializeClaudeRuntime,
  projectClaudeModelCredentialEnv,
} from './claude-config-materializer.js';
import { isOpenRouterModelRoute } from '../../../shared/model-catalog.js';
import { validateModelCredentialProjectionForEntry } from './model-provider-credential-validation.js';
import {
  ArtifactClaudeSkillSource,
  BundledClaudeSkillSource,
  CompositeSkillSource,
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

export class AnthropicClaudeAgentExecutionAdapter implements AgentExecutionAdapter {
  readonly id = 'anthropic:claude-agent-sdk' as AgentExecutionProviderId;

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

    // Developer-only: optionally launch the child runner from TypeScript source
    // (via tsx) instead of compiled dist, so breakpoints bind to .ts and edits
    // need no rebuild. Off by default; falls back to dist if source is absent.
    const runnerLaunch = this.resolveChildRunnerLaunch(
      packageRoot,
      relativeRunnerPath,
      runnerPath,
    );
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
      settings: {
        model: input.effectiveModel,
      },
    });

    const modelCredentialEnv = projectClaudeModelCredentialEnv(
      input.modelCredentialProjection.env,
    );
    if (isOpenRouterModelRoute(input.effectiveModelEntry)) {
      applyOpenRouterSdkEnv(modelCredentialEnv);
    }
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
    const selectedSkillIds = input.input.selectedSkillIds
      ? new Set(input.input.selectedSkillIds)
      : undefined;
    const skillActionDefinitions = (materialization.materializedSkills ?? [])
      .filter((skill) => !selectedSkillIds || selectedSkillIds.has(skill.id))
      .flatMap((skill) =>
        (skill.actionPermissions ?? []).map((action) => {
          if (!skill.version || !skill.contentHash) return undefined;
          return skillActionSemanticCapability({
            skillId: skill.id,
            skillName: skill.name,
            skillVersion: skill.version,
            skillContentHash: skill.contentHash,
            action,
          });
        }),
      )
      .filter(
        (item): item is ReturnType<typeof skillActionSemanticCapability> =>
          Boolean(item),
      );
    if (skillActionDefinitions.length > 0) {
      env[GANTRY_SKILL_ACTIONS_ENV] = JSON.stringify(skillActionDefinitions);
    }

    const runnerInputPatch: PreparedAgentExecution['runnerInputPatch'] = {};
    if (Object.keys(serializedModelCredentialEnv).length > 0) {
      runnerInputPatch.modelCredentialEnv = serializedModelCredentialEnv;
    }

    return {
      providerId: this.id,
      runnerPath,
      runnerArgs: runnerLaunch.runnerArgs,
      runnerInputPatch,
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

  /**
   * Map the compiled dist runner entry to its TypeScript source counterpart and
   * decide whether to launch from source. dist layout mirrors src under the same
   * package root (tsconfig rootDir=apps/core/src, outDir=dist), so the
   * `dist/<X>.js` ⇄ `apps/core/src/<X>.ts` swap is exact. Existence is checked on
   * disk; the pure builder handles the flag + inspector-port logic and falls back
   * to dist when source is unavailable.
   */
  private resolveChildRunnerLaunch(
    packageRoot: string,
    relativeRunnerPath: string,
    distRunnerPath: string,
  ): ReturnType<typeof buildChildRunnerLaunch> {
    let sourceRunnerPath: string | undefined;
    let sourceExists = false;
    if (relativeRunnerPath.startsWith(`dist${path.sep}`)) {
      const withoutDist = relativeRunnerPath.slice(`dist${path.sep}`.length);
      const candidate = path
        .join(packageRoot, 'apps', 'core', 'src', withoutDist)
        .replace(/\.js$/, '.ts');
      sourceRunnerPath = candidate;
      sourceExists = fs.existsSync(candidate);
    }

    const launch = buildChildRunnerLaunch({
      distRunnerPath,
      sourceRunnerPath,
      sourceExists,
      fromSourceFlag: process.env[CHILD_RUNNER_FROM_SOURCE_ENV],
      inspectPortRaw: process.env[CHILD_RUNNER_INSPECT_PORT_ENV],
    });

    if (launch.mode === 'source') {
      logger.warn(
        {
          runner: sourceRunnerPath,
          inspectPort: launch.inspectPort,
        },
        `${CHILD_RUNNER_FROM_SOURCE_ENV} enabled: launching agent child from TypeScript source via tsx (developer mode — do not use in production)`,
      );
    } else if (process.env[CHILD_RUNNER_FROM_SOURCE_ENV] && !sourceExists) {
      logger.warn(
        { distRunner: distRunnerPath, attemptedSource: sourceRunnerPath },
        `${CHILD_RUNNER_FROM_SOURCE_ENV} set but TypeScript source runner not found; falling back to compiled dist runner`,
      );
    }

    return launch;
  }

  private skillSources(
    input: AgentExecutionAdapterPrepareInput,
    packageRoot: string,
  ): SkillSource[] {
    const skillSources: SkillSource[] = [
      new BundledClaudeSkillSource(packageRoot),
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
