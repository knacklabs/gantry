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
import {
  findModelByRunnerModel,
  resolveModelSelection,
  resolveRunnerModel,
} from '../shared/model-catalog.js';
import { resolveGroupFolderPath } from '../platform/group-folder.js';
import {
  getHostRuntimeCredentialEnv,
  prepareHostRuntimeContext,
} from './agent-spawn-host.js';
import type { MaterializedMcpCapability } from '../application/mcp/mcp-server-service.js';
import {
  applyOpenRouterSdkEnv,
  materializeClaudeRuntime,
} from '../adapters/llm/anthropic-claude-agent/claude-config-materializer.js';
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
import {
  computeBrowserIpcAuthToken,
  createIpcAuthEnvelope,
  computeMemoryIpcAuthToken,
} from './ipc-auth.js';
import { getContinuationInputDir } from './continuation-input.js';
import { getPromptProfileService } from './prompt-profile.js';
import { executeRunnerProcess } from './agent-spawn-process.js';
import {
  applyAgentEgressNoProxyEnv,
  mergeAgentEgressNoProxy,
} from '../shared/no-proxy.js';
import { createAgentBrowserRunWiring } from './agent-browser-run-wiring.js';
import { resolveConversationBrowserProfile } from '../shared/browser-profile-scope.js';
import {
  AgentInput,
  AgentOutput,
  RunAgentOptions,
} from './agent-spawn-types.js';

type RunnerAgentInput = AgentInput & {
  modelCredentialEnv?: Record<string, string>;
};

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
  const modelConfig = getEffectiveModelConfig(
    input.isScheduledJob ? undefined : group.agentConfig?.model,
    input.isScheduledJob
      ? input.jobModelUseKind || 'recurringJob'
      : 'interactive',
    group.folder,
  );
  const requestedModel = input.model || modelConfig.model;
  const resolvedModel = requestedModel
    ? resolveModelSelection(requestedModel)
    : undefined;
  if (resolvedModel && !resolvedModel.ok) {
    return {
      status: 'error',
      result: null,
      error: resolvedModel.message,
    };
  }
  const effectiveModel = resolvedModel?.ok
    ? resolvedModel.runnerModel
    : resolveRunnerModel(modelConfig.model);
  const effectiveModelEntry =
    (resolvedModel?.ok ? resolvedModel.entry : undefined) ??
    findModelByRunnerModel(effectiveModel);
  const promptProfileService = getPromptProfileService();
  const agentIdentifier = group.folder.toLowerCase().replace(/_/g, '-');

  let compiledSystemPrompt = '';

  try {
    compiledSystemPrompt = promptProfileService.compileSystemPrompt({
      groupFolder: group.folder,
      persona: input.persona ?? group.agentConfig?.persona,
    });
  } catch (err) {
    logger.warn(
      { err, groupFolder: group.folder },
      'Failed to compile prompt profile; continuing without custom system prompt',
    );
  }

  const browserProfileName = resolveConversationBrowserProfile({
    agentId: group.folder,
    workspaceKey: group.folder,
    conversationId: input.chatJid,
  });

  const runnerInput: RunnerAgentInput = {
    ...input,
    modelCredentialEnv: undefined,
    browserProfileName,
    compiledSystemPrompt,
  };

  const hostRuntime = prepareHostRuntimeContext(group);
  ensureGroupIpcLayout(hostRuntime.groupIpcDir);
  const hostCredentials = await getHostRuntimeCredentialEnv(
    agentIdentifier,
    options?.credentialBroker,
    { purpose: 'model_runtime' },
  );
  if (
    effectiveModelEntry?.provider === 'openrouter' &&
    (!hostCredentials.env.ANTHROPIC_AUTH_TOKEN ||
      hostCredentials.credentialProviders.ANTHROPIC_AUTH_TOKEN !== 'openrouter')
  ) {
    return {
      status: 'error',
      result: null,
      error: `OpenRouter model ${effectiveModelEntry.displayName} requires an OpenRouter-scoped credential from AgentCredentialBroker as ANTHROPIC_AUTH_TOKEN. Configure Model Access/OpenRouter credentials before selecting this model.`,
    };
  }
  if (
    effectiveModelEntry &&
    effectiveModelEntry.provider !== 'openrouter' &&
    (hostCredentials.credentialProviders.ANTHROPIC_AUTH_TOKEN ===
      'openrouter' ||
      isOpenRouterBaseUrl(hostCredentials.env.ANTHROPIC_BASE_URL))
  ) {
    return {
      status: 'error',
      result: null,
      error: `Model ${effectiveModelEntry.displayName} is configured for ${effectiveModelEntry.providerLabel}, but AgentCredentialBroker returned OpenRouter-scoped Anthropic SDK credentials. Switch the session/job model to kimi or configure ${effectiveModelEntry.providerLabel} credentials for this model.`,
    };
  }
  const browserWiring = createAgentBrowserRunWiring(
    {
      isMain: input.isMain,
      browserProfileName,
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
        model: effectiveModel,
      },
    });
  } catch (err) {
    return {
      status: 'error',
      result: null,
      error: `LLM runtime materialization failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const command = process.execPath;
  const args = [hostRunnerPath];
  const ipcInputDir = getContinuationInputDir(group.folder, input.threadId);
  const ipcAuth = createIpcAuthEnvelope(group.folder, input.threadId);
  const modelCredentialEnv: NodeJS.ProcessEnv = {
    ...hostCredentials.env,
  };
  const env: NodeJS.ProcessEnv = {
    ...pickSafeHostEnv(process.env),
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
    MYCLAW_BROWSER_IPC_AUTH_TOKEN: computeBrowserIpcAuthToken(
      group.folder,
      input.chatJid,
      input.threadId,
    ),
    MYCLAW_MEMORY_IPC_AUTH_TOKEN: computeMemoryIpcAuthToken(group.folder, {
      userId: input.memoryUserId,
      defaultScope: input.memoryDefaultScope || 'group',
      threadId: input.threadId,
    }),
    MYCLAW_IPC_RESPONSE_VERIFY_KEY: ipcAuth.responseVerifyKey,
    MYCLAW_THREAD_ID: input.threadId || '',
    MYCLAW_MEMORY_USER_ID: input.memoryUserId || '',
    MYCLAW_MEMORY_DEFAULT_SCOPE: input.memoryDefaultScope || 'group',
    MYCLAW_PERMISSION_TIMEOUT_MS: String(PERMISSION_APPROVAL_TIMEOUT_MS),
    CLAUDE_CONFIG_DIR: claudeRuntimeMaterialization.claudeConfigDir,
  };
  applyAgentEgressNoProxyEnv(env);
  // Job-level model overrides group-level model.
  const effectiveModelSource = input.model ? 'job.model' : modelConfig.source;
  if (effectiveModel) {
    env.ANTHROPIC_MODEL = effectiveModel;
  }
  if (effectiveModelEntry?.provider === 'openrouter') {
    applyOpenRouterSdkEnv(modelCredentialEnv);
  }
  const serializedModelCredentialEnv = Object.fromEntries(
    Object.entries(modelCredentialEnv).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
  if (Object.keys(serializedModelCredentialEnv).length > 0) {
    runnerInput.modelCredentialEnv = serializedModelCredentialEnv;
  }
  let browserRuntimeDetails: readonly string[] = [];
  let allMcpCapabilities: MaterializedMcpCapability[] = [];
  try {
    const browserProjection = await browserWiring.activate();
    const existingNoProxy = [env.NO_PROXY, env.no_proxy] as const;
    Object.assign(env, browserProjection.env);
    const mergedNoProxy = mergeAgentEgressNoProxy(
      ...existingNoProxy,
      env.NO_PROXY,
      env.no_proxy,
    );
    env.NO_PROXY = mergedNoProxy;
    env.no_proxy = mergedNoProxy;
    browserRuntimeDetails = browserProjection.runtimeDetails;
    allMcpCapabilities = [
      ...allMcpCapabilities,
      ...browserProjection.mcpCapabilities,
    ];
    if (
      input.isScheduledJob &&
      jobAllowsBrowserActions(input.allowedTools) &&
      !allMcpCapabilities.some(
        (capability) => capability.name === BROWSER_ACTION_MCP_SERVER_NAME,
      )
    ) {
      claudeRuntimeMaterialization.cleanup();
      return {
        status: 'error',
        result: null,
        error:
          'Browser tools are on the autonomous job allowlist, but the conversation browser is unavailable. Launch the browser for this agent conversation before running the job.',
      };
    }
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

function jobAllowsBrowserActions(
  allowedTools: readonly string[] | undefined,
): boolean {
  return (allowedTools ?? []).some(
    (tool) =>
      tool === `mcp__${BROWSER_ACTION_MCP_SERVER_NAME}__*` ||
      tool.startsWith(`mcp__${BROWSER_ACTION_MCP_SERVER_NAME}__`),
  );
}

function isOpenRouterBaseUrl(value?: string): boolean {
  if (!value) return false;
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === 'openrouter.ai' || hostname.endsWith('.openrouter.ai');
  } catch {
    return false;
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
