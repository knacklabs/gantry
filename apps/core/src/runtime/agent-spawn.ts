/**
 * Agent runner for Gantry — host-only execution.
 */
import { ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import {
  DATA_DIR,
  PERMISSION_APPROVAL_TIMEOUT_MS,
  TIMEZONE,
  getRuntimeSettingsForConfig,
  getEffectiveModelConfig,
} from '../config/index.js';
import { logger } from '../infrastructure/logging/logger.js';
import { ConversationRoute } from '../domain/types.js';
import { LlmProfileResolutionService } from '../application/model-resolution/llm-profile-resolution-service.js';
import type { LlmProfile } from '../domain/agent/agent.js';
import { DEFAULT_SETUP_MODEL_ALIAS } from '../shared/model-catalog.js';
import { resolveGroupFolderPath } from '../platform/group-folder.js';
import {
  getHostRuntimeCredentialEnv,
  prepareHostRuntimeContext,
} from './agent-spawn-host.js';
import {
  McpServerService,
  type MaterializedMcpCapability,
} from '../application/mcp/mcp-server-service.js';
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
import { nowIso, nowMs as currentTimeMs } from '../shared/time/datetime.js';
import { getRuntimeFileArtifactStore } from '../adapters/storage/postgres/runtime-store.js';
import { effectiveYoloModeSettings } from '../shared/yolo-mode-policy.js';

type RunnerAgentInput = AgentInput & {
  modelCredentialEnv?: Record<string, string>;
};

const PROTECTED_FILESYSTEM_PATHS_ENV = 'GANTRY_PROTECTED_FILESYSTEM_PATHS_JSON';
const DEFAULT_RUNNER_APP_ID = 'default';

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

const PREPARED_EXECUTION_ENV_DENYLIST = new Set([
  'PATH',
  'NODE_OPTIONS',
  'LD_PRELOAD',
  'NODE_EXTRA_CA_CERTS',
]);
const PREPARED_EXECUTION_GANTRY_ENV_ALLOWLIST = new Set([
  'GANTRY_EFFECTIVE_MODEL_SOURCE',
  'GANTRY_CLAUDE_SDK_SKILLS_JSON',
  'GANTRY_SKILL_ACTIONS_JSON',
]);
const PREPARED_EXECUTION_ENV_SUFFIX_ALLOWLIST = ['_CONFIG_DIR', '_MODEL'];
const PREPARED_EXECUTION_SECRET_ENV_PATTERN =
  /(?:^|_)(?:API_)?(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)(?:_|$)/i;

function isPreparedExecutionEnvKeyAllowed(key: string): boolean {
  if (PREPARED_EXECUTION_ENV_DENYLIST.has(key)) return false;
  if (key.startsWith('GANTRY_')) {
    return PREPARED_EXECUTION_GANTRY_ENV_ALLOWLIST.has(key);
  }
  if (PREPARED_EXECUTION_SECRET_ENV_PATTERN.test(key)) return false;
  return PREPARED_EXECUTION_ENV_SUFFIX_ALLOWLIST.some((suffix) =>
    key.endsWith(suffix),
  );
}

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

function pickPreparedExecutionEnv(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'string' || value.length === 0) continue;
    if (!isPreparedExecutionEnvKeyAllowed(key)) continue;
    env[key] = value;
  }
  return env;
}

function pickSelectedCapabilityEnv(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'string' || value.length === 0) continue;
    if (PREPARED_EXECUTION_ENV_DENYLIST.has(key) || key.startsWith('GANTRY_')) {
      continue;
    }
    env[key] = value;
  }
  return env;
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
  const modelWorkload = input.isScheduledJob
    ? input.jobModelUseKind === 'oneTimeJob'
      ? 'one_time_job'
      : 'recurring_job'
    : 'chat';
  const llmProfileResolutionService = new LlmProfileResolutionService();
  const profileTimestamp = nowIso();
  const runtimeLlmProfile: LlmProfile = {
    id: `runtime:${group.folder}:${modelWorkload}` as never,
    appId: (input.appId || DEFAULT_RUNNER_APP_ID) as never,
    purpose: input.isScheduledJob ? 'coding' : 'chat',
    modelAlias:
      requestedModel || modelConfig.model || DEFAULT_SETUP_MODEL_ALIAS,
    credentialProfileRef: 'gantry-model-access',
    createdAt: profileTimestamp as never,
    updatedAt: profileTimestamp as never,
  };
  const resolvedModel = llmProfileResolutionService.resolve({
    profile: runtimeLlmProfile,
    workload: modelWorkload,
  });
  if (!resolvedModel.ok) {
    return {
      status: 'error',
      result: null,
      error: resolvedModel.message,
    };
  }
  const effectiveModel = resolvedModel.value.runnerModel;
  const effectiveModelEntry = resolvedModel.value.modelEntry;
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
  const executionAdapter = options?.executionAdapter;
  if (!executionAdapter) {
    return {
      status: 'error',
      result: null,
      error:
        'No LLM execution adapter configured. Runtime bootstrap must provide an AgentExecutionAdapter.',
    };
  }
  let preparedExecution: Awaited<ReturnType<typeof executionAdapter.prepare>>;
  try {
    preparedExecution = await executionAdapter.prepare({
      group,
      input,
      hostRuntime,
      groupDir,
      effectiveModel,
      effectiveModelEntry,
      modelCredentialProjection: {
        env: hostCredentials.env,
        credentialProviders: hostCredentials.credentialProviders,
        brokerProfile: hostCredentials.brokerProfile,
        brokerApplied: hostCredentials.brokerApplied,
        proxy: hostCredentials.proxy,
      },
      browserIpcEnabled,
      packageRootFromRunner: (runnerPath) =>
        resolvePackageRootFromSourceDir(path.dirname(runnerPath)),
      options,
    });
  } catch (err) {
    return {
      status: 'error',
      result: null,
      error: `LLM runtime materialization failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let mcpConfigPath: string | undefined;
  let egressGateway:
    | Awaited<ReturnType<typeof ensureEgressGateway>>
    | undefined;
  const ipcAuth = createIpcAuthEnvelope(group.folder, input.threadId, {
    appId: input.appId || DEFAULT_RUNNER_APP_ID,
    agentId: input.agentId,
  });
  try {
    const command = process.execPath;
    const args = preparedExecution.runnerArgs;
    const ipcInputDir = getContinuationInputDir(group.folder, input.threadId);
    const runnerAppId = input.appId || DEFAULT_RUNNER_APP_ID;
    const mcpServerPath = path.join(
      hostRuntime.runnerDistDir,
      'mcp',
      'stdio.js',
    );
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
    const upstreamProxyUrl =
      hostCredentials.proxy?.https || hostCredentials.proxy?.http;
    egressGateway = await ensureEgressGateway({
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
    const runnerInputPatch = preparedExecution.runnerInputPatch ?? {};
    runnerInputPatch.modelCredentialEnv ??= {};
    runnerInputPatch.modelCredentialEnv.HTTP_PROXY = egressGateway.proxyUrl;
    runnerInputPatch.modelCredentialEnv.HTTPS_PROXY = egressGateway.proxyUrl;
    runnerInputPatch.modelCredentialEnv.http_proxy = egressGateway.proxyUrl;
    runnerInputPatch.modelCredentialEnv.https_proxy = egressGateway.proxyUrl;
    runnerInputPatch.modelCredentialEnv.NODE_USE_ENV_PROXY = '1';
    runnerInput.modelCredentialEnv = runnerInputPatch.modelCredentialEnv;
    const env: NodeJS.ProcessEnv = {
      ...pickSafeHostEnv(process.env),
      ...pickPreparedExecutionEnv(preparedExecution.env),
      TZ: TIMEZONE,
      GANTRY_MCP_SERVER_PATH: mcpServerPath,
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
    };
    applyAgentEgressNoProxyEnv(env);
    // Job-level model overrides group-level model.
    const effectiveModelSource = input.model ? 'job.model' : modelConfig.source;

    const runtimeDetails = [
      `groupDir=${hostRuntime.groupDir}`,
      'globalDir=(none)',
      `ipcInput=${ipcInputDir}`,
      `broker=${hostCredentials.brokerProfile}`,
      `brokerApplied=${hostCredentials.brokerApplied}`,
      `mcpServers=${allMcpCapabilities.map((capability) => capability.name).join(',') || '(none)'}`,
      `browserProfile=${browserProfileName}`,
      ...preparedExecution.runtimeDetails,
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
    Object.assign(env, pickSelectedCapabilityEnv(selectedSkillEnv.env));
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
        ? [...preparedExecution.protectedFilesystemPaths, mcpConfigPath]
        : preparedExecution.protectedFilesystemPaths,
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
    if (egressGateway) {
      await closeEgressGateway(egressGateway);
    }
    preparedExecution.cleanup();
    revokeIpcResponseSigningKey(
      ipcAuth.responseKeyId,
      group.folder,
      input.threadId,
    );
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
