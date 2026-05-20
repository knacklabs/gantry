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
  applyOpenRouterSdkEnv,
  materializeClaudeRuntime,
  projectClaudeModelCredentialEnv,
} from './claude-config-materializer.js';
import {
  ArtifactClaudeSkillSource,
  BundledClaudeSkillSource,
  CompositeSkillSource,
  RuntimeInstalledGantryBrowserSkillSource,
  type SkillSource,
} from './claude-skill-materializer.js';

const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';
const ANTHROPIC_MODEL_ENV = 'ANTHROPIC_MODEL';
const GANTRY_MCP_SERVER_PATH_ENV = 'GANTRY_MCP_SERVER_PATH';

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
    if (input.effectiveModelEntry?.provider === 'openrouter') {
      applyOpenRouterSdkEnv(modelCredentialEnv);
    }
    const serializedModelCredentialEnv = Object.fromEntries(
      Object.entries(modelCredentialEnv).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );

    const env: NodeJS.ProcessEnv = {
      [CLAUDE_CONFIG_DIR_ENV]: materialization.claudeConfigDir,
      [GANTRY_MCP_SERVER_PATH_ENV]: path.join(
        input.hostRuntime.runnerDistDir,
        'mcp',
        'stdio.js',
      ),
    };
    if (input.effectiveModel) {
      env[ANTHROPIC_MODEL_ENV] = input.effectiveModel;
    }

    const runnerInputPatch: PreparedAgentExecution['runnerInputPatch'] = {};
    if (Object.keys(serializedModelCredentialEnv).length > 0) {
      runnerInputPatch.modelCredentialEnv = serializedModelCredentialEnv;
    }

    return {
      providerId: this.id,
      runnerPath,
      runnerArgs: [runnerPath],
      runnerInputPatch,
      env,
      protectedFilesystemPaths: materialization.protectedFilesystemPaths,
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
    if (
      effectiveModelEntry?.provider === 'openrouter' &&
      (!modelCredentialProjection.env.ANTHROPIC_AUTH_TOKEN ||
        modelCredentialProjection.credentialProviders.ANTHROPIC_AUTH_TOKEN !==
          'openrouter')
    ) {
      throw new Error(
        `OpenRouter model ${effectiveModelEntry.displayName} requires an OpenRouter-scoped credential from AgentCredentialBroker as ANTHROPIC_AUTH_TOKEN. Configure Model Access/OpenRouter credentials before selecting this model.`,
      );
    }
    if (
      effectiveModelEntry &&
      effectiveModelEntry.provider !== 'openrouter' &&
      (modelCredentialProjection.credentialProviders.ANTHROPIC_AUTH_TOKEN ===
        'openrouter' ||
        isOpenRouterBaseUrl(modelCredentialProjection.env.ANTHROPIC_BASE_URL))
    ) {
      throw new Error(
        `Model ${effectiveModelEntry.displayName} is configured for ${effectiveModelEntry.providerLabel}, but AgentCredentialBroker returned OpenRouter-scoped Anthropic SDK credentials. Switch the session/job model to kimi or configure ${effectiveModelEntry.providerLabel} credentials for this model.`,
      );
    }
  }
}

export function createAnthropicClaudeAgentExecutionAdapter(): AgentExecutionAdapter {
  return new AnthropicClaudeAgentExecutionAdapter();
}

function isOpenRouterBaseUrl(value?: string): boolean {
  if (!value) return false;
  try {
    const hostname = new URL(value).hostname.toLowerCase().replace(/\.+$/, '');
    return hostname === 'openrouter.ai' || hostname.endsWith('.openrouter.ai');
  } catch {
    return false;
  }
}
