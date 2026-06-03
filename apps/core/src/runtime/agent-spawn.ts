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
import { MODEL_RUNTIME_CREDENTIAL_IDENTIFIER } from '../domain/models/credentials.js';
import { LlmProfileResolutionService } from '../application/model-resolution/llm-profile-resolution-service.js';
import type { LlmProfile } from '../domain/agent/agent.js';
import {
  DEFAULT_SETUP_MODEL_ALIAS,
  type ModelCatalogEntry,
} from '../shared/model-catalog.js';
import { getModelProviderDefinition } from '../shared/model-provider-registry.js';
import { resolveWorkspaceFolderPath } from '../platform/workspace-folder.js';
import {
  getHostRuntimeCredentialEnv,
  prepareHostRuntimeContext,
} from './agent-spawn-host.js';
import {
  McpServerService,
  type MaterializedMcpCapability,
} from '../application/mcp/mcp-server-service.js';
import { ensureWorkspaceIpcLayout } from './agent-spawn-layout.js';
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
import {
  closeEgressGateway,
  ensureEgressGateway,
  type EgressNetworkAttribution,
} from './egress-gateway.js';
import { resolveConversationBrowserProfile } from '../shared/browser-profile-scope.js';
import {
  AgentInput,
  AgentOutput,
  RunAgentOptions,
} from './agent-spawn-types.js';
import { selectedMemoryIpcActionsFromToolRules } from '../shared/memory-ipc-actions.js';
import { isCanonicalBrowserCapabilityRule } from '../shared/agent-tool-references.js';
import { resolveMcpCredentialEnvForAgent } from '../application/capability-secrets/mcp-secret-projection.js';
import { resolveSelectedSkillEnvForAgent } from '../application/capability-secrets/skill-secret-projection.js';
import type { MaterializedMcpServer } from '../domain/mcp/mcp-servers.js';
import {
  reviewedExternalMcpToolNamesFromRuntimeAccess,
  type CapabilityRuntimeAccess,
} from '../shared/capability-runtime-access.js';
import {
  filterMcpToolNamesBySourceScopes,
  reviewedMcpToolPatterns,
} from '../shared/mcp-tool-scope.js';
import { nowIso, nowMs as currentTimeMs } from '../shared/time/datetime.js';
import { getRuntimeFileArtifactStore } from '../adapters/storage/postgres/runtime-store.js';
import { effectiveYoloModeSettings } from '../shared/yolo-mode-policy.js';
import { formatGeneratedRuntimePathPermissionError } from './generated-runtime-path-error.js';
import { resolveAgentExecutionAdapter } from '../application/agent-execution/agent-execution-adapter-registry.js';
import { writeRunnerMcpConfigFile } from './agent-spawn-mcp-config.js';
import { validateRunnerAllowedTools } from './agent-spawn-tool-validation.js';
type RunnerAgentInput = AgentInput & {
  modelCredentialEnv?: Record<string, string>;
};

const PROTECTED_FILESYSTEM_PATHS_ENV = 'GANTRY_PROTECTED_FILESYSTEM_PATHS_JSON';
const PROTECTED_FILESYSTEM_DENY_READ_PATHS_ENV =
  'GANTRY_PROTECTED_FILESYSTEM_DENY_READ_PATHS_JSON';
const PROTECTED_FILESYSTEM_DENY_WRITE_PATHS_ENV =
  'GANTRY_PROTECTED_FILESYSTEM_DENY_WRITE_PATHS_JSON';
const LOCAL_CLI_CREDENTIAL_DIRS_ENV = 'GANTRY_LOCAL_CLI_CREDENTIAL_DIRS_JSON';
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

function resolveHomeRelativePaths(
  values: readonly string[],
  source: NodeJS.ProcessEnv,
): string[] {
  const home = source.HOME ?? source.USERPROFILE;
  const out = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (trimmed === '~') {
      if (home) out.add(home);
      continue;
    }
    if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
      if (home) out.add(path.join(home, trimmed.slice(2)));
      continue;
    }
    const expanded = expandCredentialPathTemplate(trimmed, source);
    if (expanded) out.add(expanded);
  }
  return [...out];
}
function localCliCredentialPathHintsFromRuntimeAccess(
  runtimeAccess: AgentInput['runtimeAccess'],
): string[] {
  const dirs = (runtimeAccess ?? []).flatMap((access) =>
    access.sourceType === 'local_cli' ? access.credentialDirs : [],
  );
  return [...new Set(dirs.map((dir) => dir.trim()).filter(Boolean))];
}
function egressNetworkAttributionFromRuntimeAccess(
  runtimeAccess: AgentInput['runtimeAccess'],
): EgressNetworkAttribution[] {
  const attribution: EgressNetworkAttribution[] = [];
  for (const access of runtimeAccess ?? []) {
    if (
      access.sourceType === 'local_cli' ||
      access.sourceType === 'skill_action'
    ) {
      for (const binding of access.networkBindings ?? []) {
        for (const host of binding.hosts ?? []) {
          const trimmed = host.trim();
          if (!trimmed) continue;
          attribution.push({
            host: trimmed,
            capabilityId: access.selectedCapabilityId,
            capabilityLabel: access.auditLabel,
          });
        }
      }
      continue;
    }
    if (access.sourceType === 'mcp_server') {
      for (const host of access.networkHosts ?? []) {
        const trimmed = host.trim();
        if (!trimmed) continue;
        attribution.push({
          host: trimmed,
          capabilityId: access.selectedCapabilityId,
          capabilityLabel: access.auditLabel,
        });
      }
    }
  }
  return attribution;
}

function modelProviderNetworkHostsFromModelEntry(
  modelEntry: ModelCatalogEntry | undefined,
): string[] {
  if (!modelEntry) return [];
  const provider = getModelProviderDefinition(modelEntry.modelRoute.id);
  if (!provider?.gateway?.upstreamOrigin) return [];
  try {
    const upstream = new URL(provider.gateway.upstreamOrigin);
    const host = upstream.hostname.trim();
    if (!host) return [];
    const port =
      upstream.port || (upstream.protocol === 'http:' ? '80' : '443');
    return [`${host}:${port}`];
  } catch {
    return [];
  }
}

function withStdioMcpEgressEnv(
  capabilities: readonly MaterializedMcpCapability[],
  env: NodeJS.ProcessEnv,
): MaterializedMcpCapability[] {
  return capabilities.map((capability) => {
    if (capability.config.type !== 'stdio') return capability;
    const proxyEnv = {
      HTTP_PROXY: env.GANTRY_EGRESS_PROXY_URL ?? '',
      HTTPS_PROXY: env.GANTRY_EGRESS_PROXY_URL ?? '',
      http_proxy: env.GANTRY_EGRESS_PROXY_URL ?? '',
      https_proxy: env.GANTRY_EGRESS_PROXY_URL ?? '',
      NODE_USE_ENV_PROXY: '1',
      NO_PROXY: env.NO_PROXY ?? '',
      no_proxy: env.no_proxy ?? '',
    };
    return {
      ...capability,
      config: {
        ...capability.config,
        env: {
          ...(capability.config.env ?? {}),
          ...proxyEnv,
        },
      },
    };
  });
}

function attachMcpSourceNetworkHosts(
  runtimeAccess: readonly CapabilityRuntimeAccess[],
  capabilities: readonly MaterializedMcpCapability[],
): CapabilityRuntimeAccess[] {
  const hostsByServer = new Map(
    capabilities.map((capability) => [
      capability.name,
      capability.networkHosts,
    ]),
  );
  return runtimeAccess.map((access) => {
    if (access.sourceType !== 'mcp_server') return access;
    const serverName = mcpServerNameFromRuntimeAccess(access);
    const sourceHosts = serverName ? hostsByServer.get(serverName) : undefined;
    if (!sourceHosts?.length) return access;
    return {
      ...access,
      networkHosts: [...new Set([...access.networkHosts, ...sourceHosts])],
    };
  });
}

function mcpServerNameFromRuntimeAccess(
  access: Extract<CapabilityRuntimeAccess, { sourceType: 'mcp_server' }>,
): string | undefined {
  if (access.reviewedServerId && access.reviewedServerId !== 'unknown') {
    return access.reviewedServerId;
  }
  for (const toolName of access.allowedTools) {
    const match = /^mcp__([A-Za-z0-9_-]+)__/.exec(toolName.trim());
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function expandCredentialPathTemplate(
  value: string,
  source: NodeJS.ProcessEnv,
): string | null {
  let missing = false;
  const expanded = value
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, key: string) => {
      const envValue = source[key];
      if (!envValue) missing = true;
      return envValue ?? '';
    })
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_match, key: string) => {
      const envValue = source[key];
      if (!envValue) missing = true;
      return envValue ?? '';
    })
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_match, key: string) => {
      const envValue = source[key];
      if (!envValue) missing = true;
      return envValue ?? '';
    });
  return missing ? null : expanded;
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

export async function spawnAgent(
  group: ConversationRoute,
  input: AgentInput,
  onProcess: (proc: ChildProcess, runHandle: string) => void,
  onOutput?: (output: AgentOutput) => Promise<void>,
  options?: RunAgentOptions,
): Promise<AgentOutput> {
  const startTime = currentTimeMs();

  const groupDir = resolveWorkspaceFolderPath(group.folder);
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
    id: `transient-runtime-profile:${group.folder}:${modelWorkload}` as never,
    appId: (input.appId || DEFAULT_RUNNER_APP_ID) as never,
    purpose: input.isScheduledJob ? 'coding' : 'chat',
    modelAlias:
      requestedModel || modelConfig.model || DEFAULT_SETUP_MODEL_ALIAS,
    credentialProfileRef: MODEL_RUNTIME_CREDENTIAL_IDENTIFIER,
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
  const allowedToolValidationError = validateRunnerAllowedTools(input);
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
  ensureWorkspaceIpcLayout(hostRuntime.workspaceIpcDir);
  let executionAdapter: NonNullable<RunAgentOptions['executionAdapter']>;
  try {
    executionAdapter = resolveAgentExecutionAdapter({
      executionProviderId: effectiveModelEntry.executionProviderId,
      registry: options?.executionAdapters,
      fallback: options?.executionAdapter,
    }) as NonNullable<RunAgentOptions['executionAdapter']>;
  } catch (err) {
    return {
      status: 'error',
      result: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (!executionAdapter) {
    return {
      status: 'error',
      result: null,
      error:
        'No LLM execution adapter configured. Runtime bootstrap must provide an AgentExecutionAdapterRegistry.',
    };
  }
  const hostCredentials = await getHostRuntimeCredentialEnv(
    agentIdentifier,
    options?.credentialBroker,
    {
      purpose: 'model_runtime',
      runContext: input,
      modelRouteId: effectiveModelEntry?.modelRoute.id,
    },
  );
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
    await hostCredentials.revoke?.().catch((revokeErr) => {
      logger.warn(
        { err: revokeErr },
        'Failed to revoke model gateway token after LLM runtime materialization failure',
      );
    });
    const errorText = err instanceof Error ? err.message : String(err);
    const generatedRuntimeError = formatGeneratedRuntimePathPermissionError({
      runnerLabel: 'LLM runtime materialization',
      errorText,
    });
    return {
      status: 'error',
      result: null,
      error:
        generatedRuntimeError ??
        `LLM runtime materialization failed: ${errorText}`,
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
    const attachedMcpSourceIds = input.attachedMcpSourceIds ?? [];
    const mcpSourceRecords: MaterializedMcpServer[] =
      options?.mcpServerRepository &&
      options.mcpContext?.appId &&
      options.mcpContext.agentId &&
      attachedMcpSourceIds.length > 0
        ? await options.mcpServerRepository.listMaterializedServersForAgent({
            appId: options.mcpContext.appId as never,
            agentId: options.mcpContext.agentId as never,
            serverIds: attachedMcpSourceIds as never,
          })
        : [];
    const mcpSourceScopes = mcpSourceRecords.map(({ definition, binding }) => ({
      name: definition.name,
      allowedToolPatterns:
        binding.allowedToolPatterns.length > 0
          ? binding.allowedToolPatterns
          : reviewedMcpToolPatterns(definition),
    }));
    const sourceScopedReviewedMcpToolNames = filterMcpToolNamesBySourceScopes(
      reviewedExternalMcpToolNamesFromRuntimeAccess(input.runtimeAccess ?? [], {
        serverNames: mcpSourceScopes.map((scope) => scope.name),
      }),
      mcpSourceScopes,
    );
    const reviewedMcpServerNames = new Set(
      sourceScopedReviewedMcpToolNames.flatMap((toolName) => {
        const match = /^mcp__([A-Za-z0-9_-]+)__/.exec(toolName.trim());
        return match?.[1] ? [match[1]] : [];
      }),
    );
    const directMcpSourceRecords = mcpSourceRecords.filter(
      ({ definition }) =>
        definition.config.transport === 'stdio_template' &&
        reviewedMcpServerNames.has(definition.name),
    );
    const directMcpServerNames = new Set(
      directMcpSourceRecords.map(({ definition }) => definition.name),
    );
    const reviewedMcpToolNames = sourceScopedReviewedMcpToolNames.filter(
      (toolName) => {
        const match = /^mcp__([A-Za-z0-9_-]+)__/.exec(toolName.trim());
        return match?.[1] ? directMcpServerNames.has(match[1]) : false;
      },
    );
    const projectedMcpSourceIds = directMcpSourceRecords.map(
      ({ definition }) => definition.id,
    );
    const allMcpCapabilities: MaterializedMcpCapability[] =
      options?.mcpServerRepository &&
      options.capabilitySecretRepository &&
      options.mcpContext?.appId &&
      options.mcpContext.agentId &&
      projectedMcpSourceIds.length > 0
        ? await new McpServerService(options.mcpServerRepository, undefined, {
            lookupHostname: options.mcpHostnameLookup,
            dnsValidationCache: options.mcpDnsValidationCache,
          }).materializeForAgent({
            appId: options.mcpContext.appId as never,
            agentId: options.mcpContext.agentId as never,
            serverIds: projectedMcpSourceIds as never,
            credentialEnv: await resolveMcpCredentialEnvForAgent({
              appId: options.mcpContext.appId as never,
              agentId: options.mcpContext.agentId as never,
              serverIds: projectedMcpSourceIds as never,
              mcpServers: options.mcpServerRepository,
              secrets: options.capabilitySecretRepository,
            }),
          })
        : [];
    const effectiveRuntimeAccess = attachMcpSourceNetworkHosts(
      input.runtimeAccess ?? [],
      allMcpCapabilities,
    );
    runnerInput.runtimeAccess = effectiveRuntimeAccess;
    const modelProviderNetworkHosts =
      modelProviderNetworkHostsFromModelEntry(effectiveModelEntry);
    const networkAttribution = egressNetworkAttributionFromRuntimeAccess(
      effectiveRuntimeAccess,
    );
    const memoryIpcAllowedActions = selectedMemoryIpcActionsFromToolRules(
      trustedAllowedTools ?? [],
      {
        memoryReviewerIsControlApprover: input.memoryReviewerIsControlApprover,
      },
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
      modelProviderNetworkHosts,
      networkAttribution,
      ...(options?.mcpHostnameLookup
        ? { lookupHostname: options.mcpHostnameLookup }
        : {}),
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
    if (runnerInputPatch.semanticCapabilities) {
      runnerInput.semanticCapabilities = runnerInputPatch.semanticCapabilities;
    }
    const localCliCredentialPaths = resolveHomeRelativePaths(
      localCliCredentialPathHintsFromRuntimeAccess(effectiveRuntimeAccess),
      process.env,
    );
    const env: NodeJS.ProcessEnv = {
      ...pickSafeHostEnv(process.env),
      ...pickPreparedExecutionEnv(preparedExecution.env),
      TZ: TIMEZONE,
      GANTRY_MCP_SERVER_PATH: mcpServerPath,
      GANTRY_WORKSPACE_GROUP_DIR: hostRuntime.groupDir,
      GANTRY_WORKSPACE_GLOBAL_DIR: '',
      GANTRY_WORKSPACE_KEY: group.folder,
      GANTRY_APP_ID: runnerAppId,
      ...(input.agentId ? { GANTRY_AGENT_ID: input.agentId } : {}),
      GANTRY_AGENT_RUN_HANDLE: processName,
      GANTRY_WORKSPACE_EXTRA_DIR: path.join(
        DATA_DIR,
        'sessions',
        group.folder,
        'extra',
      ),
      GANTRY_IPC_DIR: hostRuntime.workspaceIpcDir,
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
    applyAgentEgressNoProxyEnv(env, { externalBypass: false });
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
            runtimeAccess: effectiveRuntimeAccess,
          })
        : { env: {} };
    Object.assign(env, pickSelectedCapabilityEnv(selectedSkillEnv.env));
    mcpConfigPath =
      allMcpCapabilities.length > 0
        ? writeRunnerMcpConfigFile(
            hostRuntime.workspaceIpcDir,
            withStdioMcpEgressEnv(allMcpCapabilities, env),
          )
        : undefined;
    if (mcpConfigPath) {
      env.GANTRY_MCP_CONFIG_FILE = mcpConfigPath;
      env.GANTRY_MCP_ALLOWED_TOOLS_JSON = JSON.stringify(reviewedMcpToolNames);
      env.GANTRY_MCP_ALWAYS_ALLOWED_TOOLS_JSON =
        env.GANTRY_MCP_ALLOWED_TOOLS_JSON;
    }
    const protectedFilesystemDenyReadPaths = [
      ...(preparedExecution.protectedFilesystemDenyReadPaths ??
        preparedExecution.protectedFilesystemPaths),
      ...(mcpConfigPath ? [mcpConfigPath] : []),
    ];
    const protectedFilesystemDenyWritePaths = [
      ...(preparedExecution.protectedFilesystemDenyWritePaths ??
        preparedExecution.protectedFilesystemPaths),
      ...localCliCredentialPaths,
      ...(mcpConfigPath ? [mcpConfigPath] : []),
    ];
    env[PROTECTED_FILESYSTEM_DENY_READ_PATHS_ENV] = JSON.stringify(
      protectedFilesystemDenyReadPaths,
    );
    env[PROTECTED_FILESYSTEM_DENY_WRITE_PATHS_ENV] = JSON.stringify(
      protectedFilesystemDenyWritePaths,
    );
    env[PROTECTED_FILESYSTEM_PATHS_ENV] = JSON.stringify(
      protectedFilesystemDenyWritePaths,
    );
    if (localCliCredentialPaths.length > 0) {
      env[LOCAL_CLI_CREDENTIAL_DIRS_ENV] = JSON.stringify(
        localCliCredentialPaths,
      );
    }
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
    await hostCredentials.revoke?.();
    preparedExecution.cleanup();
    revokeIpcResponseSigningKey(
      ipcAuth.responseKeyId,
      group.folder,
      input.threadId,
    );
  }
}
