/**
 * Agent runner for MyClaw — host-only execution.
 */
import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  DATA_DIR,
  PERMISSION_APPROVAL_TIMEOUT_MS,
  TIMEZONE,
  getEffectiveModelConfig,
} from '../config/index.js';
import { logger } from '../infrastructure/logging/logger.js';
import { RegisteredGroup } from '../domain/types.js';
import { normalizeClaudeModelSelection } from '../models/claude-model-registry.js';
import { resolveGroupFolderPath } from '../platform/group-folder.js';
import {
  getHostRuntimeCredentialEnv,
  prepareHostRuntimeContext,
} from './agent-spawn-host.js';
import type { MaterializedMcpCapability } from '../application/mcp/mcp-server-service.js';
import { materializeClaudeRuntime } from '../adapters/llm/anthropic-claude-agent/claude-config-materializer.js';
import {
  ArtifactClaudeSkillSource,
  BundledClaudeSkillSource,
  BROWSER_ACTION_MCP_SERVER_NAME,
  CompositeSkillSource,
  RuntimeInstalledAgentBrowserSkillSource,
  createBrowserActionMcpServerConfig,
  type SkillSource,
} from '../adapters/llm/anthropic-claude-agent/claude-skill-materializer.js';
import { ensureGroupIpcLayout } from './agent-spawn-layout.js';
import { resolvePackageRootFromSourceDir } from '../platform/package-root.js';
import { createIpcAuthEnvelope } from './ipc-auth.js';
import { getContinuationInputDir } from './continuation-input.js';
import { getPromptProfileService } from './prompt-profile.js';
import { executeRunnerProcess } from './agent-spawn-process.js';
import { applyLoopbackNoProxyEnv } from '../shared/no-proxy.js';
import { createAgentBrowserRunWiring } from './agent-browser-run-wiring.js';
import {
  AgentInput,
  AgentOutput,
  RunAgentOptions,
} from './agent-spawn-types.js';

export { writeGroupsSnapshot } from './agent-spawn-snapshots.js';
export type {
  AvailableGroup,
  AgentInput,
  AgentOutput,
} from './agent-spawn-types.js';

const SAFE_HOST_ENV_KEYS = [
  'PATH',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'NO_PROXY',
  'no_proxy',
] as const;

function pickSafeHostEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_HOST_ENV_KEYS) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) {
      env[key] = value;
    }
  }
  return env;
}

export async function spawnAgent(
  group: RegisteredGroup,
  input: AgentInput,
  onProcess: (proc: ChildProcess, runHandle: string) => void,
  onOutput?: (output: AgentOutput) => Promise<void>,
  options?: RunAgentOptions,
): Promise<AgentOutput> {
  const startTime = Date.now();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const processName = `myclaw-${safeName}-${Date.now()}`;
  const modelConfig = getEffectiveModelConfig(group.agentConfig?.model);
  const promptProfileService = getPromptProfileService();
  const agentIdentifier = input.isMain
    ? undefined
    : group.folder.toLowerCase().replace(/_/g, '-');

  let compiledSystemPrompt = '';

  try {
    compiledSystemPrompt = promptProfileService.compileSystemPrompt({
      groupFolder: group.folder,
    });
  } catch (err) {
    logger.warn(
      { err, groupFolder: group.folder },
      'Failed to compile prompt profile; continuing without custom system prompt',
    );
  }

  const runnerInput: AgentInput = {
    ...input,
    compiledSystemPrompt,
  };

  const hostRuntime = prepareHostRuntimeContext(group);
  ensureGroupIpcLayout(hostRuntime.groupIpcDir);
  const hostCredentials = await getHostRuntimeCredentialEnv(
    agentIdentifier,
    options?.credentialBroker,
  );
  const browserWiring = createAgentBrowserRunWiring(
    {
      isMain: input.isMain,
    },
    {
      browserSkillSource: new RuntimeInstalledAgentBrowserSkillSource(),
      actionMcpServerName: BROWSER_ACTION_MCP_SERVER_NAME,
      createActionMcpServerConfig: createBrowserActionMcpServerConfig,
    },
  );
  const hostRunnerPath = path.join(
    hostRuntime.runnerDistDir,
    'claude',
    'index.js',
  );
  const mcpServerPath = path.join(hostRuntime.runnerDistDir, 'mcp', 'stdio.js');
  if (!fs.existsSync(hostRunnerPath) || !fs.existsSync(mcpServerPath)) {
    return {
      status: 'error',
      result: null,
      error:
        'Host runtime is missing required runner files. Reinstall MyClaw from npm and restart.',
    };
  }
  let claudeRuntimeMaterialization: Awaited<
    ReturnType<typeof materializeClaudeRuntime>
  >;
  try {
    const packageRoot = resolvePackageRootFromSourceDir(
      path.dirname(hostRunnerPath),
    );
    const skillSources: SkillSource[] = [
      new BundledClaudeSkillSource(packageRoot),
    ];
    skillSources.push(...browserWiring.skillSources);
    if (
      options?.skillRepository &&
      options.skillArtifactStore &&
      options.skillContext?.appId &&
      options.skillContext.agentId
    ) {
      skillSources.push(
        new ArtifactClaudeSkillSource(
          options.skillRepository,
          options.skillArtifactStore,
          {
            appId: options.skillContext.appId as never,
            agentId: options.skillContext.agentId as never,
          },
        ),
      );
    }
    claudeRuntimeMaterialization = await materializeClaudeRuntime({
      groupDir,
      baseTempDir: path.join(groupDir, '.claude-runtime'),
      cleanupPolicy: 'retain-for-debug',
      cliEntryPoint: path.join(packageRoot, 'dist', 'cli', 'index.js'),
      packageRoot,
      skillSource: new CompositeSkillSource(skillSources),
      settings: {
        model: normalizeClaudeModelSelection(input.model || modelConfig.model),
      },
    });
  } catch (err) {
    return {
      status: 'error',
      result: null,
      error: `Claude runtime materialization failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const command = process.execPath;
  const args = [hostRunnerPath];
  const ipcInputDir = getContinuationInputDir(group.folder, input.threadId);
  const ipcAuth = createIpcAuthEnvelope(group.folder, input.threadId);
  const env: NodeJS.ProcessEnv = {
    ...pickSafeHostEnv(process.env),
    ...hostCredentials.env,
    TZ: TIMEZONE,
    MYCLAW_WORKSPACE_GROUP_DIR: hostRuntime.groupDir,
    MYCLAW_WORKSPACE_GLOBAL_DIR: hostRuntime.globalDir || '',
    MYCLAW_GROUP_FOLDER: group.folder,
    MYCLAW_WORKSPACE_EXTRA_DIR: path.join(
      DATA_DIR,
      'sessions',
      group.folder,
      'extra',
    ),
    MYCLAW_IPC_DIR: hostRuntime.groupIpcDir,
    MYCLAW_IPC_INPUT_DIR: ipcInputDir,
    MYCLAW_IPC_AUTH_TOKEN: ipcAuth.authToken,
    MYCLAW_IPC_RESPONSE_VERIFY_KEY: ipcAuth.responseVerifyKey,
    MYCLAW_THREAD_ID: input.threadId || '',
    MYCLAW_PERMISSION_TIMEOUT_MS: String(PERMISSION_APPROVAL_TIMEOUT_MS),
    CLAUDE_CONFIG_DIR: claudeRuntimeMaterialization.claudeConfigDir,
  };
  applyLoopbackNoProxyEnv(env);
  // Job-level model overrides group-level model.
  const effectiveModel = normalizeClaudeModelSelection(
    input.model || modelConfig.model,
  );
  const effectiveModelSource = input.model ? 'job.model' : modelConfig.source;
  if (effectiveModel) {
    env.ANTHROPIC_MODEL = effectiveModel;
  }
  let browserRuntimeDetails: readonly string[] = [];
  let allMcpCapabilities: MaterializedMcpCapability[] = [];
  try {
    const browserProjection = await browserWiring.activate();
    Object.assign(env, browserProjection.env);
    browserRuntimeDetails = browserProjection.runtimeDetails;
    allMcpCapabilities = [
      ...allMcpCapabilities,
      ...browserProjection.mcpCapabilities,
    ];
  } catch (err) {
    claudeRuntimeMaterialization.cleanup();
    return {
      status: 'error',
      result: null,
      error: `Browser wiring failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const mcpConfigPath =
    allMcpCapabilities.length > 0
      ? writeRunnerMcpConfigFile(hostRuntime.groupIpcDir, allMcpCapabilities)
      : undefined;
  if (mcpConfigPath) {
    env.MYCLAW_MCP_CONFIG_FILE = mcpConfigPath;
    env.MYCLAW_MCP_ALLOWED_TOOLS_JSON = JSON.stringify(
      allMcpCapabilities.flatMap((capability) => capability.allowedToolNames),
    );
    env.MYCLAW_MCP_ALWAYS_ALLOWED_TOOLS_JSON = JSON.stringify(
      allMcpCapabilities.flatMap(
        (capability) => capability.autoApproveToolNames,
      ),
    );
  }

  const runtimeDetails = [
    `groupDir=${hostRuntime.groupDir}`,
    `globalDir=${hostRuntime.globalDir || '(none)'}`,
    `ipcInput=${ipcInputDir}`,
    `broker=${hostCredentials.brokerProfile}`,
    `brokerApplied=${hostCredentials.brokerApplied}`,
    `mcpServers=${allMcpCapabilities.map((capability) => capability.name).join(',') || '(none)'}`,
    `runner=${hostRunnerPath}`,
    ...browserRuntimeDetails,
  ];

  logger.debug(
    {
      group: group.name,
      processName,
      command,
      args: args.join(' '),
      runtimeDetails,
    },
    'Host agent runtime configuration',
  );

  logger.info(
    {
      group: group.name,
      processName,
      model: effectiveModel ?? null,
      modelSource: effectiveModelSource,
      isMain: input.isMain,
      systemPromptChars: compiledSystemPrompt.length,
    },
    'Spawning host agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  try {
    const output = await executeRunnerProcess({
      group,
      input: runnerInput,
      command,
      args,
      env,
      onProcess,
      onOutput,
      options,
      runnerLabel: 'Host agent',
      processName,
      startTime,
      logsDir,
      runtimeDetails,
    });
    return output;
  } finally {
    cleanupRunnerMcpConfigFile(mcpConfigPath);
    claudeRuntimeMaterialization.cleanup();
  }
}

function writeRunnerMcpConfigFile(
  groupIpcDir: string,
  capabilities: MaterializedMcpCapability[],
): string {
  const configPath = path.join(
    groupIpcDir,
    `mcp-${globalThis.crypto.randomUUID()}.json`,
  );
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      Object.fromEntries(
        capabilities.map((capability) => [capability.name, capability.config]),
      ),
    ),
    { encoding: 'utf-8', mode: 0o600 },
  );
  return configPath;
}

function cleanupRunnerMcpConfigFile(configPath: string | undefined): void {
  if (!configPath) return;
  try {
    fs.rmSync(configPath, { force: true });
  } catch (err) {
    logger.warn(
      { err, configPath },
      'Failed to remove MCP runner handoff file',
    );
  }
}
