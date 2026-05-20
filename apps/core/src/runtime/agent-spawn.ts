/**
 * Agent runner for Gantry — host-only execution.
 */
import { ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  ARTIFACTS_DIR,
  DATA_DIR,
  PERMISSION_APPROVAL_TIMEOUT_MS,
  RUNTIME_SETTINGS_PATH,
  TIMEZONE,
  getRuntimeSettingsForConfig,
  getEffectiveModelConfig,
} from '../config/index.js';
import { logger } from '../infrastructure/logging/logger.js';
import { ConversationRoute } from '../domain/types.js';
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
import {
  McpServerService,
  type MaterializedMcpCapability,
} from '../application/mcp/mcp-server-service.js';
import {
  applyOpenRouterSdkEnv,
  materializeClaudeRuntime,
  projectClaudeModelCredentialEnv,
} from '../adapters/llm/anthropic-claude-agent/claude-config-materializer.js';
import {
  ArtifactClaudeSkillSource,
  BundledClaudeSkillSource,
  CompositeSkillSource,
  RuntimeInstalledGantryBrowserSkillSource,
  type SkillSource,
} from '../adapters/llm/anthropic-claude-agent/claude-skill-materializer.js';
import { ensureGroupIpcLayout } from './agent-spawn-layout.js';
import { resolvePackageRootFromSourceDir } from '../platform/package-root.js';
import {
  computeBrowserIpcAuthToken,
  createIpcAuthEnvelope,
  computeMemoryIpcAuthToken,
  registerBrowserIpcAuthorization,
  revokeBrowserIpcAuthorization,
  revokeIpcResponseSigningKey,
} from './ipc-auth.js';
import { getContinuationInputDir } from './continuation-input.js';
import {
  PromptProfileService,
  promptProfileAgentIdForFolder,
} from '../application/agents/prompt-profile-service.js';
import { executeRunnerProcess } from './agent-spawn-process.js';
import { applyAgentEgressNoProxyEnv } from '../shared/no-proxy.js';
import { closeEgressGateway, ensureEgressGateway } from './egress-gateway.js';
import { resolveConversationBrowserProfile } from '../shared/browser-profile-scope.js';
import {
  AgentInput,
  AgentOutput,
  RunAgentOptions,
} from './agent-spawn-types.js';
import { selectedMemoryIpcActionsFromToolRules } from '../shared/memory-ipc-actions.js';
import { isCanonicalBrowserCapabilityRule } from '../shared/agent-tool-references.js';
import { validateAgentToolRuntimeRules } from '../application/agents/agent-tool-runtime-rules.js';
import { resolveMcpCredentialEnvForAgent } from '../application/capability-secrets/mcp-secret-projection.js';
import { resolveSelectedSkillEnvForAgent } from '../application/capability-secrets/skill-secret-projection.js';
import { nowMs as currentTimeMs } from '../shared/time/datetime.js';
import { getRuntimeFileArtifactStore } from '../adapters/storage/postgres/runtime-store.js';
import { effectiveYoloModeSettings } from '../shared/yolo-mode-policy.js';

type RunnerAgentInput = AgentInput & {
  modelCredentialEnv?: Record<string, string>;
};

const PROTECTED_FILESYSTEM_PATHS_ENV = 'GANTRY_PROTECTED_FILESYSTEM_PATHS_JSON';
const DEFAULT_RUNNER_APP_ID = 'default';
const BROKER_HEADER_REWRITE_PLACEHOLDER = 'placeholder';
const MODEL_PROVIDER_ENV_PREFIX = 'ANTHRO' + 'PIC';
const MODEL_AUTH_TOKEN_ENV = MODEL_PROVIDER_ENV_PREFIX + '_AUTH_TOKEN';
const MODEL_API_KEY_ENV = MODEL_PROVIDER_ENV_PREFIX + '_API_KEY';

type HostRuntimeCredentialEnv = Awaited<
  ReturnType<typeof getHostRuntimeCredentialEnv>
>;

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

function hasOpenRouterScopedAuthToken(
  credentials: HostRuntimeCredentialEnv,
): boolean {
  return (
    Boolean(credentials.env[MODEL_AUTH_TOKEN_ENV]) &&
    credentials.credentialProviders[MODEL_AUTH_TOKEN_ENV] === 'openrouter'
  );
}

function hasOnecliHeaderRewriteCredential(
  credentials: HostRuntimeCredentialEnv,
): boolean {
  return (
    credentials.brokerApplied &&
    credentials.brokerProfile === 'onecli' &&
    credentials.env[MODEL_API_KEY_ENV] === BROKER_HEADER_REWRITE_PLACEHOLDER &&
    Boolean(
      credentials.proxy?.https ||
      credentials.proxy?.http ||
      credentials.env.HTTPS_PROXY ||
      credentials.env.HTTP_PROXY ||
      credentials.env.https_proxy ||
      credentials.env.http_proxy,
    )
  );
}

function canProjectOpenRouterCredentials(
  credentials: HostRuntimeCredentialEnv,
): boolean {
  return (
    hasOpenRouterScopedAuthToken(credentials) ||
    hasOnecliHeaderRewriteCredential(credentials)
  );
}

function applyOpenRouterCredentialProjection(
  env: NodeJS.ProcessEnv,
  credentials: HostRuntimeCredentialEnv,
): void {
  if (!hasOpenRouterScopedAuthToken(credentials)) {
    env[MODEL_AUTH_TOKEN_ENV] = BROKER_HEADER_REWRITE_PLACEHOLDER;
  }
}

function validateRunnerAllowedTools(rules: readonly string[]): string | null {
  try {
    validateAgentToolRuntimeRules({
      rules,
      errorSubject: 'Configured agent tool',
    });
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

export async function spawnAgent(
  group: ConversationRoute,
  input: AgentInput,
  onProcess: (proc: ChildProcess, runHandle: string) => void,
  onOutput?: (output: AgentOutput) => Promise<void>,
  options?: RunAgentOptions,
): Promise<AgentOutput> {
  const startTime = currentTimeMs();

  const groupDir = resolveGroupFolderPath(group.folder);
  fs.mkdirSync(groupDir, { recursive: true });

  const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  const processName = `gantry-${safeName}-${currentTimeMs()}-${randomUUID().slice(0, 8)}`;
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
  const allowedToolValidationError = validateRunnerAllowedTools(
    input.allowedTools ?? [],
  );
  if (allowedToolValidationError) {
    return {
      status: 'error',
      result: null,
      error: allowedToolValidationError,
    };
  }
  const promptProfileService = new PromptProfileService({
    fileArtifactStore: () => getRuntimeFileArtifactStore(),
  });
  const agentIdentifier = group.folder.toLowerCase().replace(/_/g, '-');

  let compiledSystemPrompt = '';

  try {
    compiledSystemPrompt = await promptProfileService.compileSystemPrompt({
      agentFolder: group.folder,
      persona: input.persona ?? group.agentConfig?.persona,
      appId: input.appId || DEFAULT_RUNNER_APP_ID,
      agentId: input.agentId || promptProfileAgentIdForFolder(group.folder),
    });
  } catch (err) {
    logger.warn(
      { err, agentFolder: group.folder },
      'Failed to compile prompt profile; continuing without custom system prompt',
    );
  }

  const browserProfileName = resolveConversationBrowserProfile({
    agentId: group.folder,
    workspaceKey: group.folder,
    conversationId: input.chatJid,
  });

  const trustedAllowedTools = input.allowedTools;
  const browserIpcEnabled = (trustedAllowedTools ?? []).some(
    isCanonicalBrowserCapabilityRule,
  );

  const runnerInput: RunnerAgentInput = {
    ...input,
    allowedTools: trustedAllowedTools,
    modelCredentialEnv: undefined,
    browserProfileName,
    compiledSystemPrompt,
    yoloMode: effectiveYoloModeSettings(
      getRuntimeSettingsForConfig().permissions.yoloMode,
    ),
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
    !canProjectOpenRouterCredentials(hostCredentials)
  ) {
    return {
      status: 'error',
      result: null,
      error: `OpenRouter model ${effectiveModelEntry.displayName} requires AgentCredentialBroker to provide either an OpenRouter-scoped ANTHROPIC_AUTH_TOKEN or a OneCLI header-rewrite proxy credential. Configure Model Access/OpenRouter credentials before selecting this model.`,
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
        'Host runtime is missing required runner files. Reinstall Gantry from npm and restart.',
    };
  }
  let llmRuntimeMaterialization: Awaited<
    ReturnType<typeof materializeClaudeRuntime>
  >;
  let packageRoot = '';
  try {
    packageRoot = resolvePackageRootFromSourceDir(path.dirname(hostRunnerPath));
    const skillSources: SkillSource[] = [
      new BundledClaudeSkillSource(packageRoot),
    ];
    if (browserIpcEnabled) {
      skillSources.push(new RuntimeInstalledGantryBrowserSkillSource());
    }
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
    llmRuntimeMaterialization = await materializeClaudeRuntime({
      groupDir,
      baseTempDir: path.join(groupDir, '.llm-runtime'),
      cleanupPolicy: 'retain-for-debug',
      cliEntryPoint: path.join(packageRoot, 'dist', 'cli', 'index.js'),
      packageRoot,
      runtimeSettingsPath: RUNTIME_SETTINGS_PATH,
      managedSkillArtifactRoots: [path.join(ARTIFACTS_DIR, 'skills')],
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
  const runnerAppId = input.appId || DEFAULT_RUNNER_APP_ID;
  const ipcAuth = createIpcAuthEnvelope(group.folder, input.threadId, {
    appId: runnerAppId,
    agentId: input.agentId,
  });
  const selectedMcpServerIds = input.selectedMcpServerIds ?? [];
  const allMcpCapabilities: MaterializedMcpCapability[] =
    options?.mcpServerRepository &&
    options.capabilitySecretRepository &&
    options.mcpContext?.appId &&
    options.mcpContext.agentId &&
    selectedMcpServerIds.length > 0
      ? await new McpServerService(options.mcpServerRepository, undefined, {
          lookupHostname: options.mcpHostnameLookup,
          dnsValidationCache: options.mcpDnsValidationCache,
        }).materializeForAgent({
          appId: options.mcpContext.appId as never,
          agentId: options.mcpContext.agentId as never,
          serverIds: selectedMcpServerIds as never,
          credentialEnv: options.capabilitySecretRepository
            ? await resolveMcpCredentialEnvForAgent({
                appId: options.mcpContext.appId as never,
                agentId: options.mcpContext.agentId as never,
                serverIds: selectedMcpServerIds as never,
                mcpServers: options.mcpServerRepository,
                secrets: options.capabilitySecretRepository,
              })
            : {},
        })
      : [];
  const memoryIpcAllowedActions = selectedMemoryIpcActionsFromToolRules(
    trustedAllowedTools ?? [],
  );
  const modelCredentialEnv = projectClaudeModelCredentialEnv(
    hostCredentials.env,
  );
  const upstreamProxyUrl =
    hostCredentials.proxy?.https || hostCredentials.proxy?.http;
  const egressGateway = await ensureEgressGateway({
    key: `${runnerAppId}:${input.agentId || group.folder}:${processName}`,
    settings: getRuntimeSettingsForConfig().permissions.egress,
    principal: {
      appId: runnerAppId,
      conversationId: input.chatJid,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.jobId ? { jobId: input.jobId } : {}),
    },
    ...(upstreamProxyUrl
      ? {
          upstreamProxy: {
            url: upstreamProxyUrl,
            provider: hostCredentials.brokerProfile,
          },
        }
      : {}),
    ...(options?.publishRuntimeEvent
      ? { publishRuntimeEvent: options.publishRuntimeEvent }
      : {}),
  });
  modelCredentialEnv.HTTP_PROXY = egressGateway.proxyUrl;
  modelCredentialEnv.HTTPS_PROXY = egressGateway.proxyUrl;
  modelCredentialEnv.http_proxy = egressGateway.proxyUrl;
  modelCredentialEnv.https_proxy = egressGateway.proxyUrl;
  modelCredentialEnv.NODE_USE_ENV_PROXY = '1';
  const { claudeConfigDir } = llmRuntimeMaterialization;
  const env: NodeJS.ProcessEnv = {
    ...pickSafeHostEnv(process.env),
    TZ: TIMEZONE,
    GANTRY_WORKSPACE_GROUP_DIR: hostRuntime.groupDir,
    GANTRY_WORKSPACE_GLOBAL_DIR: '',
    GANTRY_GROUP_FOLDER: group.folder,
    GANTRY_APP_ID: runnerAppId,
    ...(input.agentId ? { GANTRY_AGENT_ID: input.agentId } : {}),
    GANTRY_AGENT_RUN_HANDLE: processName,
    GANTRY_WORKSPACE_EXTRA_DIR: path.join(
      DATA_DIR,
      'sessions',
      group.folder,
      'extra',
    ),
    GANTRY_IPC_DIR: hostRuntime.groupIpcDir,
    GANTRY_IPC_INPUT_DIR: ipcInputDir,
    GANTRY_IPC_AUTH_TOKEN: ipcAuth.authToken,
    GANTRY_CHAT_JID: input.chatJid,
    ...(input.jobId ? { GANTRY_JOB_ID: input.jobId } : {}),
    ...(input.jobName ? { GANTRY_JOB_NAME: input.jobName } : {}),
    ...(input.runId ? { GANTRY_JOB_RUN_ID: input.runId } : {}),
    ...(browserIpcEnabled
      ? {
          GANTRY_BROWSER_IPC_AUTH_TOKEN: computeBrowserIpcAuthToken(
            group.folder,
            input.chatJid,
            input.threadId,
          ),
        }
      : {}),
    GANTRY_MEMORY_IPC_AUTH_TOKEN: computeMemoryIpcAuthToken(group.folder, {
      chatJid: input.chatJid,
      userId: input.memoryUserId,
      defaultScope: input.memoryDefaultScope || 'group',
      threadId: input.threadId,
      allowedActions: memoryIpcAllowedActions,
      reviewerIsControlApprover: input.memoryReviewerIsControlApprover,
    }),
    GANTRY_MEMORY_IPC_ACTIONS_JSON: JSON.stringify(memoryIpcAllowedActions),
    GANTRY_IPC_RESPONSE_VERIFY_KEY: ipcAuth.responseVerifyKey,
    GANTRY_IPC_RESPONSE_KEY_ID: ipcAuth.responseKeyId,
    GANTRY_THREAD_ID: input.threadId || '',
    GANTRY_MEMORY_USER_ID: input.memoryUserId || '',
    GANTRY_MEMORY_DEFAULT_SCOPE: input.memoryDefaultScope || 'group',
    GANTRY_MEMORY_REVIEWER_IS_CONTROL_APPROVER:
      input.memoryReviewerIsControlApprover ? '1' : '',
    GANTRY_INTERACTIVE_PERMISSION_TIMEOUT_MS: String(
      PERMISSION_APPROVAL_TIMEOUT_MS,
    ),
    GANTRY_PERMISSION_TIMEOUT_MS: String(PERMISSION_APPROVAL_TIMEOUT_MS),
    GANTRY_EGRESS_PROXY_URL: egressGateway.proxyUrl,
    CLAUDE_CONFIG_DIR: claudeConfigDir,
  };
  applyAgentEgressNoProxyEnv(env);
  // Job-level model overrides group-level model.
  const effectiveModelSource = input.model ? 'job.model' : modelConfig.source;
  if (effectiveModel) {
    env.ANTHROPIC_MODEL = effectiveModel;
  }
  if (effectiveModelEntry?.provider === 'openrouter') {
    applyOpenRouterSdkEnv(modelCredentialEnv);
    applyOpenRouterCredentialProjection(modelCredentialEnv, hostCredentials);
  }
  const serializedModelCredentialEnv = Object.fromEntries(
    Object.entries(modelCredentialEnv).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
  if (Object.keys(serializedModelCredentialEnv).length > 0) {
    runnerInput.modelCredentialEnv = serializedModelCredentialEnv;
  }
  let mcpConfigPath: string | undefined;

  const runtimeDetails = [
    `groupDir=${hostRuntime.groupDir}`,
    'globalDir=(none)',
    `ipcInput=${ipcInputDir}`,
    `broker=${hostCredentials.brokerProfile}`,
    `brokerApplied=${hostCredentials.brokerApplied}`,
    `mcpServers=${allMcpCapabilities.map((capability) => capability.name).join(',') || '(none)'}`,
    `runner=${hostRunnerPath}`,
    `browserProfile=${browserProfileName}`,
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
      systemPromptChars: compiledSystemPrompt.length,
    },
    'Spawning host agent',
  );

  const logsDir = path.join(groupDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  try {
    const selectedSkillEnv =
      options?.skillRepository &&
      options.capabilitySecretRepository &&
      options.skillContext?.appId &&
      options.skillContext.agentId
        ? await resolveSelectedSkillEnvForAgent({
            appId: options.skillContext.appId as never,
            agentId: options.skillContext.agentId as never,
            skills: options.skillRepository,
            secrets: options.capabilitySecretRepository,
          })
        : { env: {} };
    if (selectedSkillEnv.missingMessage) {
      return {
        status: 'error',
        result: null,
        error: selectedSkillEnv.missingMessage,
      };
    }
    Object.assign(env, selectedSkillEnv.env);
    mcpConfigPath =
      allMcpCapabilities.length > 0
        ? writeRunnerMcpConfigFile(hostRuntime.groupIpcDir, allMcpCapabilities)
        : undefined;
    if (mcpConfigPath) {
      env.GANTRY_MCP_CONFIG_FILE = mcpConfigPath;
      env.GANTRY_MCP_ALLOWED_TOOLS_JSON = JSON.stringify(
        allMcpCapabilities.flatMap((capability) => capability.allowedToolNames),
      );
      env.GANTRY_MCP_ALWAYS_ALLOWED_TOOLS_JSON = JSON.stringify(
        allMcpCapabilities.flatMap(
          (capability) => capability.autoApproveToolNames,
        ),
      );
    }
    env[PROTECTED_FILESYSTEM_PATHS_ENV] = JSON.stringify(
      mcpConfigPath
        ? [...llmRuntimeMaterialization.protectedFilesystemPaths, mcpConfigPath]
        : llmRuntimeMaterialization.protectedFilesystemPaths,
    );
    if (browserIpcEnabled) {
      registerBrowserIpcAuthorization({
        workspaceKey: group.folder,
        chatJid: input.chatJid,
        threadId: input.threadId,
      });
    }
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
    if (browserIpcEnabled) {
      revokeBrowserIpcAuthorization({
        workspaceKey: group.folder,
        chatJid: input.chatJid,
        threadId: input.threadId,
      });
    }
    cleanupRunnerMcpConfigFile(mcpConfigPath);
    await closeEgressGateway(egressGateway);
    llmRuntimeMaterialization.cleanup();
    revokeIpcResponseSigningKey(
      ipcAuth.responseKeyId,
      group.folder,
      input.threadId,
    );
  }
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
