import { ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  DATA_DIR,
  PERMISSION_APPROVAL_TIMEOUT_MS,
  TIMEZONE,
  getDeploymentMode,
  getRuntimeSettingsForConfig,
  getEffectiveModelConfig,
  getSelectedAgentHarness,
} from '../config/index.js';
import { resolveAgentAccessPolicy } from '../config/profiles.js';
import { logger } from '../infrastructure/logging/logger.js';
import { ConversationRoute } from '../domain/types.js';
import { MODEL_RUNTIME_CREDENTIAL_IDENTIFIER } from '../domain/models/credentials.js';
import { LlmProfileResolutionService } from '../application/model-resolution/llm-profile-resolution-service.js';
import type { LlmProfile } from '../domain/agent/agent.js';
import { DEFAULT_SETUP_MODEL_ALIAS } from '../shared/model-catalog.js';
import { rewriteModelFamilyAliasForApp } from './model-family-resolution.js';
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
import { buildToolNetworkEnv } from '../shared/tool-network-env.js';
import { closeEgressGateway, ensureEgressGateway } from './egress-gateway.js';
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
import {
  attachMcpSourceNetworkHosts,
  egressNetworkAttributionFromRuntimeAccess,
  LOCAL_CLI_CREDENTIAL_DIRS_ENV,
  localCliCredentialPathHintsFromRuntimeAccess,
  pickPreparedExecutionEnv,
  pickSafeHostEnv,
  pickSelectedCapabilityEnv,
  PROTECTED_FILESYSTEM_DENY_READ_PATHS_ENV,
  PROTECTED_FILESYSTEM_DENY_WRITE_PATHS_ENV,
  PROTECTED_FILESYSTEM_PATHS_ENV,
  resolveHomeRelativePaths,
  resolveRunnerMcpProjection,
  sandboxAllowedNetworkHostsFromRuntimeAccess,
} from './agent-spawn-runtime-policy.js';
import { nowIso, nowMs as currentTimeMs } from '../shared/time/datetime.js';
import {
  getConfiguredModelProvidersForApp,
  getRuntimeFileArtifactStore,
} from '../adapters/storage/postgres/runtime-store.js';
import { effectiveYoloModeSettings } from '../shared/yolo-mode-policy.js';
import { formatGeneratedRuntimePathPermissionError } from './generated-runtime-path-error.js';
import { resolveAgentExecutionAdapter } from '../application/agent-execution/agent-execution-adapter-registry.js';
import { writeRunnerMcpConfigFile } from './agent-spawn-mcp-config.js';
import { withStdioMcpEgressEnv } from './agent-spawn-mcp-egress-env.js';
import { createRunnerHostStartupTiming } from './agent-spawn-startup-timing.js';
import { validateAgentPreSpawnAdmission } from './agent-spawn-admission.js';
import {
  cleanupRunnerMcpConfigFile,
  cleanupRunnerTempDir,
  buildSandboxRuntimeGatewayOptions,
  deepAgentsShellEnabledEnv,
  protectedWritePathsForOuterSandbox,
  sandboxRuntimeToolProcessEnv,
  sandboxRuntimeToolNetworkEnv,
  type RunnerAgentInput,
} from './agent-spawn-helpers.js';
const DEFAULT_RUNNER_APP_ID = 'default';
export { writeGroupsSnapshot } from './agent-spawn-snapshots.js';
export type {
  AvailableGroup,
  AgentInput,
  AgentOutput,
} from './agent-spawn-types.js';

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export async function spawnAgent(
  group: ConversationRoute,
  input: AgentInput,
  onProcess: (proc: ChildProcess, runHandle: string) => void,
  onOutput: ((output: AgentOutput) => Promise<void>) | undefined,
  options: RunAgentOptions,
): Promise<AgentOutput> {
  const startTime = currentTimeMs();
  const hostStartup = createRunnerHostStartupTiming({ nowMs: currentTimeMs });
  const { groupDir, processName } = hostStartup.measure(
    'workspacePrepMs',
    () => {
      const resolvedGroupDir = resolveWorkspaceFolderPath(group.folder);
      fs.mkdirSync(resolvedGroupDir, { recursive: true, mode: 0o700 });
      try {
        fs.chmodSync(resolvedGroupDir, 0o700);
      } catch (err) {
        logger.warn(
          { err, groupDir: resolvedGroupDir },
          'Failed to tighten agent workspace mode',
        );
      }
      const safeName = group.folder.replace(/[^a-zA-Z0-9-]/g, '-');
      return {
        groupDir: resolvedGroupDir,
        processName: `gantry-${safeName}-${currentTimeMs()}-${randomUUID().slice(0, 8)}`,
      };
    },
  );
  const modelResolutionStarted = hostStartup.start();
  const modelConfig = getEffectiveModelConfig(
    input.isScheduledJob ? undefined : group.agentConfig?.model,
    input.isScheduledJob
      ? input.jobModelUseKind || 'recurringJob'
      : 'interactive',
    group.folder,
  );
  const requestedModel = input.model || modelConfig.model;
  const agentHarness = getSelectedAgentHarness(group.folder);
  // Credential-driven model-family selection (live path): a family alias is
  // rewritten to the concrete member whose provider has a configured credential.
  const familyResolvedModel = await rewriteModelFamilyAliasForApp({
    alias: requestedModel || modelConfig.model || DEFAULT_SETUP_MODEL_ALIAS,
    appId: input.appId || DEFAULT_RUNNER_APP_ID,
    listConfiguredProviders: getConfiguredModelProvidersForApp,
    familyOrder: getRuntimeSettingsForConfig().modelFamilies,
  });
  const modelWorkload = input.isScheduledJob
    ? input.jobModelUseKind === 'oneTimeJob'
      ? 'one_time_job'
      : 'recurring_job'
    : 'chat';
  // Engine is a read-only diagnostic derived from the resolved model's
  // provider; jobs and conversations inherit it and there is no engine selector.
  // Resolution must fail before the runner process starts.
  const runtimeSettings = getRuntimeSettingsForConfig();
  const llmProfileResolutionService = new LlmProfileResolutionService();
  const profileTimestamp = nowIso();
  const runtimeLlmProfile: LlmProfile = {
    id: `transient-runtime-profile:${group.folder}:${modelWorkload}` as never,
    appId: (input.appId || DEFAULT_RUNNER_APP_ID) as never,
    purpose: input.isScheduledJob ? 'coding' : 'chat',
    modelAlias: familyResolvedModel,
    credentialProfileRef: MODEL_RUNTIME_CREDENTIAL_IDENTIFIER,
    createdAt: profileTimestamp as never,
    updatedAt: profileTimestamp as never,
  };
  const resolvedModel = llmProfileResolutionService.resolve({
    profile: runtimeLlmProfile,
    workload: modelWorkload,
    agentHarness,
  });
  hostStartup.finish('modelResolutionMs', modelResolutionStarted);
  if (!resolvedModel.ok) {
    return {
      status: 'error',
      result: null,
      error: resolvedModel.message,
    };
  }
  const agentEngine = resolvedModel.value.agentEngine;
  const effectiveModel = resolvedModel.value.runnerModel;
  const effectiveModelEntry = resolvedModel.value.modelEntry;
  // Pre-spawn tool-rule admission: invalid runner tool rules, plus DeepAgents
  // shell/filesystem authority (disabled in v1; the future enablement path also
  // requires an enforcing sandbox under production/remote posture). Engine and
  // resolved tool rules are both known here, so these fail closed before spawn.
  const preSpawnAdmissionError = hostStartup.measure(
    'preSpawnAdmissionMs',
    () =>
      validateAgentPreSpawnAdmission({
        agentInput: input,
        agentEngine,
        securityEnv: process.env,
        sandboxProvider: runtimeSettings.runtime.sandbox.provider,
      }),
  );
  if (preSpawnAdmissionError) {
    return { status: 'error', result: null, error: preSpawnAdmissionError };
  }
  const promptProfileService = new PromptProfileService({
    fileArtifactStore: () => getRuntimeFileArtifactStore(),
  });
  const agentIdentifier = group.folder.toLowerCase().replace(/_/g, '-');
  // The instruction projection follows the same resolved access policy as the
  // tool surface: locked agents get the locked prompt fragments.
  const agentAccessPolicy = resolveAgentAccessPolicy(
    runtimeSettings.agents?.[group.folder]?.accessPreset,
  );
  const isLockedAgent = agentAccessPolicy.preset === 'locked';
  let compiledSystemPrompt = '';
  try {
    compiledSystemPrompt = await hostStartup.measureAsync(
      'promptCompileMs',
      () =>
        promptProfileService.compileSystemPrompt({
          agentFolder: group.folder,
          persona: input.persona ?? group.agentConfig?.persona,
          appId: input.appId || DEFAULT_RUNNER_APP_ID,
          agentId: input.agentId || promptProfileAgentIdForFolder(group.folder),
          accessPreset: agentAccessPolicy.preset,
        }),
    );
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
  const trustedToolPolicyRules = input.toolPolicyRules;
  const browserIpcEnabled = (trustedToolPolicyRules ?? []).some(
    isCanonicalBrowserCapabilityRule,
  );
  const hideAuthorityTools =
    isLockedAgent ||
    input.hideAuthorityTools === true ||
    process.env.GANTRY_NO_PERMISSION_TOOLS === '1';
  const runnerInput: RunnerAgentInput = {
    ...input,
    allowedTools: trustedToolPolicyRules,
    browserProfileName,
    hideAuthorityTools,
    compiledSystemPrompt,
    yoloMode: effectiveYoloModeSettings(runtimeSettings.permissions.yoloMode),
  };

  const hostRuntime = prepareHostRuntimeContext(group);
  ensureWorkspaceIpcLayout(hostRuntime.workspaceIpcDir);
  let executionAdapter: NonNullable<RunAgentOptions['executionAdapter']>;
  try {
    executionAdapter = resolveAgentExecutionAdapter({
      executionProviderId: resolvedModel.value.executionProviderId,
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
  const hostCredentials = await hostStartup.measureAsync(
    'credentialProjectionMs',
    () =>
      getHostRuntimeCredentialEnv(agentIdentifier, options?.credentialBroker, {
        purpose: 'model_runtime',
        runContext: input,
        modelRouteId: effectiveModelEntry?.modelRoute.id,
      }),
  );
  let preparedExecution: Awaited<ReturnType<typeof executionAdapter.prepare>>;
  try {
    preparedExecution = await hostStartup.measureAsync('adapterPrepareMs', () =>
      executionAdapter.prepare({
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
          ...(hostCredentials.brokerAuthMode
            ? { brokerAuthMode: hostCredentials.brokerAuthMode }
            : {}),
          proxy: hostCredentials.proxy,
        },
        browserIpcEnabled,
        packageRootFromRunner: (runnerPath) =>
          resolvePackageRootFromSourceDir(path.dirname(runnerPath)),
        options,
      }),
    );
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
  let sandboxConfigPath: string | undefined;
  let runnerTempDir: string | undefined;
  let providerToolTempDir: string | undefined;
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
    let reviewedMcpToolNames: string[] = [];
    let allMcpCapabilities: MaterializedMcpCapability[] = [];
    let selectedMcpServerNames: string[] = [];
    let effectiveRuntimeAccess = input.runtimeAccess ?? [];
    await hostStartup.measureAsync('mcpProjectionMs', async () => {
      const mcpSourceRecords =
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
      selectedMcpServerNames = uniqueStrings([
        ...mcpSourceRecords.map((record) => record.definition.name),
        ...attachedMcpSourceIds.map((sourceId) =>
          sourceId.startsWith('mcp:')
            ? sourceId.slice('mcp:'.length)
            : sourceId,
        ),
      ]);
      const projection = resolveRunnerMcpProjection(agentEngine, {
        runtimeAccess: input.runtimeAccess ?? [],
        mcpSourceRecords,
      });
      reviewedMcpToolNames = projection.reviewedMcpToolNames;
      const projectedMcpSourceIds = projection.projectedMcpSourceIds;
      allMcpCapabilities =
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
      effectiveRuntimeAccess = attachMcpSourceNetworkHosts(
        input.runtimeAccess ?? [],
        allMcpCapabilities,
      );
    });
    runnerInput.runtimeAccess = effectiveRuntimeAccess;
    const networkAttribution = egressNetworkAttributionFromRuntimeAccess(
      effectiveRuntimeAccess,
    );
    const sandboxAllowedNetworkHosts =
      sandboxAllowedNetworkHostsFromRuntimeAccess(effectiveRuntimeAccess);
    const memoryIpcAllowedActions = selectedMemoryIpcActionsFromToolRules(
      trustedToolPolicyRules ?? [],
      {
        memoryReviewerIsControlApprover: input.memoryReviewerIsControlApprover,
      },
    );
    const upstreamProxyUrl =
      hostCredentials.proxy?.https || hostCredentials.proxy?.http;
    const runnerInputPatch = preparedExecution.runnerInputPatch ?? {};
    runnerInput.modelCredentialEnv = runnerInputPatch.modelCredentialEnv;
    const runtimeSandbox = getRuntimeSettingsForConfig().runtime.sandbox;
    const runnerSandboxProviderId =
      options?.runnerSandboxProvider?.id ?? 'direct';
    if (runnerSandboxProviderId !== runtimeSandbox.provider) {
      throw new Error(
        `Runner sandbox provider mismatch: settings.yaml has ${runtimeSandbox.provider}, but the live runtime provider is ${runnerSandboxProviderId}. Restart Gantry before running agents.`,
      );
    }
    const sandboxRuntimeGateway = buildSandboxRuntimeGatewayOptions(
      runnerSandboxProviderId,
      sandboxAllowedNetworkHosts,
      runnerInput.modelCredentialEnv,
    );
    runnerInput.modelCredentialEnv = sandboxRuntimeGateway.modelCredentialEnv;
    runnerInputPatch.modelCredentialEnv =
      sandboxRuntimeGateway.modelCredentialEnv;
    egressGateway = await hostStartup.measureAsync('egressGatewayMs', () =>
      ensureEgressGateway({
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
        networkAttribution,
        ...sandboxRuntimeGateway.gatewayOptions,
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
      }),
    );
    const runnerEnvStarted = hostStartup.start();
    const toolNetworkEnv = sandboxRuntimeToolNetworkEnv(
      runnerSandboxProviderId,
      runnerInputPatch.toolNetworkEnv ??
        buildToolNetworkEnv({
          proxyUrl: egressGateway.proxyUrl,
          caBundlePath:
            runnerInputPatch.modelCredentialEnv?.NODE_EXTRA_CA_CERTS ??
            hostCredentials.env.NODE_EXTRA_CA_CERTS,
          noProxy: {
            NO_PROXY: process.env.NO_PROXY,
            no_proxy: process.env.no_proxy,
          },
        }),
    );
    runnerInputPatch.toolNetworkEnv = toolNetworkEnv;
    runnerInput.toolNetworkEnv = toolNetworkEnv;
    if (runnerInputPatch.semanticCapabilities) {
      runnerInput.semanticCapabilities = runnerInputPatch.semanticCapabilities;
    }
    const localCliCredentialPaths = resolveHomeRelativePaths(
      localCliCredentialPathHintsFromRuntimeAccess(effectiveRuntimeAccess),
      process.env,
    );
    const workspaceExtraDir = path.join(
      DATA_DIR,
      'sessions',
      group.folder,
      'extra',
    );
    if (runnerSandboxProviderId === 'sandbox_runtime') {
      const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
      runnerTempDir = path.join('/tmp', `gantry-srt-${suffix}`);
      fs.mkdirSync(runnerTempDir, { recursive: false, mode: 0o700 });
      const providerToolTempDirLeaf =
        preparedExecution.sandboxRuntime?.toolTempDirLeaf;
      if (providerToolTempDirLeaf) {
        providerToolTempDir = path.join(runnerTempDir, providerToolTempDirLeaf);
        fs.mkdirSync(providerToolTempDir, { recursive: true, mode: 0o700 });
      }
    }
    const env: NodeJS.ProcessEnv = {
      ...pickSafeHostEnv(process.env),
      ...pickPreparedExecutionEnv(preparedExecution.env),
      ...sandboxRuntimeToolProcessEnv(runnerSandboxProviderId, toolNetworkEnv),
      ...(runnerTempDir
        ? {
            TMPDIR: runnerTempDir,
            TMP: runnerTempDir,
            TEMP: runnerTempDir,
            ...(preparedExecution.sandboxRuntime?.tempEnv?.(runnerTempDir) ??
              {}),
          }
        : {}),
      TZ: TIMEZONE,
      GANTRY_MCP_SERVER_PATH: mcpServerPath,
      GANTRY_WORKSPACE_GROUP_DIR: hostRuntime.groupDir,
      GANTRY_WORKSPACE_GLOBAL_DIR: '',
      GANTRY_WORKSPACE_KEY: group.folder,
      GANTRY_APP_ID: runnerAppId,
      ...(input.agentId ? { GANTRY_AGENT_ID: input.agentId } : {}),
      GANTRY_AGENT_RUN_HANDLE: processName,
      GANTRY_WORKSPACE_EXTRA_DIR: workspaceExtraDir,
      GANTRY_IPC_DIR: hostRuntime.workspaceIpcDir,
      GANTRY_IPC_INPUT_DIR: ipcInputDir,
      GANTRY_IPC_AUTH_TOKEN: ipcAuth.authToken,
      GANTRY_CHAT_JID: input.chatJid,
      ...(input.jobId ? { GANTRY_JOB_ID: input.jobId } : {}),
      ...(input.jobName ? { GANTRY_JOB_NAME: input.jobName } : {}),
      ...(input.runId ? { GANTRY_JOB_RUN_ID: input.runId } : {}),
      ...(input.runLeaseToken
        ? { GANTRY_JOB_RUN_LEASE_TOKEN: input.runLeaseToken }
        : {}),
      ...(typeof input.runLeaseFencingVersion === 'number'
        ? {
            GANTRY_JOB_RUN_LEASE_FENCING_VERSION: String(
              input.runLeaseFencingVersion,
            ),
          }
        : {}),
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
      GANTRY_NO_PERMISSION_TOOLS: hideAuthorityTools ? '1' : '',
      GANTRY_AGENT_ACCESS_PRESET: agentAccessPolicy.preset,
      GANTRY_DEPLOYMENT_MODE: getDeploymentMode(),
      GANTRY_INTERACTIVE_PERMISSION_TIMEOUT_MS: String(
        PERMISSION_APPROVAL_TIMEOUT_MS,
      ),
      GANTRY_PERMISSION_TIMEOUT_MS: String(PERMISSION_APPROVAL_TIMEOUT_MS),
      GANTRY_EGRESS_PROXY_URL: egressGateway.proxyUrl,
      ...(runnerSandboxProviderId === 'sandbox_runtime'
        ? { GANTRY_SANDBOX_RUNTIME_PROXY: '1' }
        : {}),
      // DeepAgents shell-tool flag, derived from the pre-spawn guard inputs (see
      // deepAgentsShellEnabledEnv); only '1' on the allowed sandbox path.
      ...deepAgentsShellEnabledEnv({
        engine: agentEngine,
        toolPolicyRules: trustedToolPolicyRules,
        securityEnv: process.env,
        sandboxProvider: runnerSandboxProviderId,
      }),
    };
    applyAgentEgressNoProxyEnv(env, { externalBypass: false });
    hostStartup.finish('runnerEnvMs', runnerEnvStarted);
    // Job-level model overrides group-level model.
    const effectiveModelSource = input.model ? 'job.model' : modelConfig.source;

    const runtimeDetails = [
      `groupDir=${hostRuntime.groupDir}`,
      'globalDir=(none)',
      `ipcInput=${ipcInputDir}`,
      `sandbox=${options?.runnerSandboxProvider?.id ?? 'direct'} enforcing=${options?.runnerSandboxProvider?.enforcing === true}`,
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
    const selectedSkillEnv = await hostStartup.measureAsync(
      'selectedSkillEnvMs',
      () =>
        options?.skillRepository &&
        options.capabilitySecretRepository &&
        options.skillContext?.appId &&
        options.skillContext.agentId
          ? resolveSelectedSkillEnvForAgent({
              appId: options.skillContext.appId as never,
              agentId: options.skillContext.agentId as never,
              skills: options.skillRepository,
              secrets: options.capabilitySecretRepository,
              runtimeAccess: effectiveRuntimeAccess,
            })
          : Promise.resolve({ env: {} }),
    );
    Object.assign(env, pickSelectedCapabilityEnv(selectedSkillEnv.env));
    mcpConfigPath = hostStartup.measure('mcpConfigMs', () =>
      allMcpCapabilities.length > 0
        ? writeRunnerMcpConfigFile(
            hostRuntime.workspaceIpcDir,
            withStdioMcpEgressEnv(allMcpCapabilities, toolNetworkEnv),
          )
        : undefined,
    );
    const sandboxSpecStarted = hostStartup.start();
    if (mcpConfigPath) {
      env.GANTRY_MCP_CONFIG_FILE = mcpConfigPath;
      env.GANTRY_MCP_ALLOWED_TOOLS_JSON = JSON.stringify(reviewedMcpToolNames);
      env.GANTRY_MCP_ALWAYS_ALLOWED_TOOLS_JSON =
        env.GANTRY_MCP_ALLOWED_TOOLS_JSON;
    }
    const runnerVisibleMcpServerNames = uniqueStrings([
      ...selectedMcpServerNames,
      ...allMcpCapabilities.map((capability) => capability.name),
    ]);
    if (runnerVisibleMcpServerNames.length > 0) {
      env.GANTRY_SELECTED_MCP_SERVERS_JSON = JSON.stringify(
        runnerVisibleMcpServerNames,
      );
    }
    const protectedFilesystemDenyReadPaths = [
      ...(preparedExecution.protectedFilesystemDenyReadPaths ??
        preparedExecution.protectedFilesystemPaths),
      ...(mcpConfigPath ? [mcpConfigPath] : []),
    ];
    const providerConfigDir = preparedExecution.runtimeConfigDir;
    const sandboxRunnerReadablePaths = [
      ...(providerConfigDir
        ? [path.join(providerConfigDir, 'settings.json')]
        : []),
      ...(mcpConfigPath ? [mcpConfigPath] : []),
    ].map((item) => path.resolve(item));
    const sandboxProtectedReadPaths = protectedFilesystemDenyReadPaths.filter(
      (item) => !sandboxRunnerReadablePaths.includes(path.resolve(item)),
    );
    const protectedFilesystemDenyWritePaths = [
      ...(preparedExecution.protectedFilesystemDenyWritePaths ??
        preparedExecution.protectedFilesystemPaths),
      ...localCliCredentialPaths,
    ];
    const sandboxProtectedWritePaths = protectedWritePathsForOuterSandbox(
      protectedFilesystemDenyWritePaths,
      providerConfigDir,
    );
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
    sandboxConfigPath = path.join(
      hostRuntime.workspaceIpcDir,
      `${processName}.sandbox-runtime.json`,
    );
    const runnerPackageRoot = resolvePackageRootFromSourceDir(
      path.dirname(args[0] ?? hostRuntime.runnerDistDir),
    );
    hostStartup.finish('sandboxSpecMs', sandboxSpecStarted);
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
      startupHostPhases: hostStartup.payload(),
      logsDir,
      runtimeDetails,
      sandbox: {
        cwd: hostRuntime.groupDir,
        workspaceRoot: hostRuntime.groupDir,
        configFilePath: sandboxConfigPath,
        egressProxyUrl: egressGateway?.proxyUrl,
        allowedNetworkHosts:
          sandboxRuntimeGateway.gatewayOptions.allowedNetworkHosts ??
          sandboxAllowedNetworkHosts,
        runtimeReadPaths: [
          runnerPackageRoot,
          hostRuntime.workspaceIpcDir,
          workspaceExtraDir,
          ...(providerConfigDir ? [providerConfigDir] : []),
          ...(runnerTempDir ? [runnerTempDir] : []),
          ...(providerToolTempDir ? [providerToolTempDir] : []),
          ...localCliCredentialPaths,
          ...(mcpConfigPath ? [mcpConfigPath] : []),
        ],
        runtimeWritePaths: [
          hostRuntime.workspaceIpcDir,
          ...(providerConfigDir ? [providerConfigDir] : []),
          ...(runnerTempDir ? [runnerTempDir] : []),
          ...(providerToolTempDir ? [providerToolTempDir] : []),
        ],
        protectedReadPaths: sandboxProtectedReadPaths,
        protectedWritePaths: sandboxProtectedWritePaths,
        resourceLimits: runtimeSandbox.resourceLimits,
        sandboxProfile: {
          id: 'runner-default',
          network: 'required',
          filesystem: 'workspace_write',
        },
        principal: {
          appId: runnerAppId,
          agentId: input.agentId,
          conversationId: input.chatJid,
          threadId: input.threadId,
          runId: input.runId,
          jobId: input.jobId,
        },
      },
    });
    return output;
  } finally {
    cleanupRunnerTempDir(runnerTempDir, logger.warn.bind(logger));
    if (browserIpcEnabled) {
      revokeBrowserIpcAuthorization({
        workspaceKey: group.folder,
        chatJid: input.chatJid,
        threadId: input.threadId,
      });
    }
    cleanupRunnerMcpConfigFile(mcpConfigPath, logger.warn.bind(logger));
    cleanupRunnerMcpConfigFile(sandboxConfigPath, logger.warn.bind(logger));
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
