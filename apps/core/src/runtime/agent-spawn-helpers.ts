import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

import type { AgentInput } from './agent-spawn-types.js';
import type { EgressGatewayPrivateHostMapping } from './egress-gateway.js';
import type {
  RunnerSandboxProvider,
  RunnerSandboxProviderId,
  RunnerSandboxResourceLimits,
  RunnerSandboxSpawnInput,
  RunnerSandboxWarmTemplateStatus,
} from '../shared/runner-sandbox-provider.js';
import { projectSandboxRuntimeModelGatewayEnv } from './agent-spawn-runtime-policy.js';
import {
  deepAgentsFilesystemToolsEnabled,
  deepAgentsShellToolEnabled,
  type DeepAgentsShellFilesystemGuardInput,
} from './deepagents-shell-filesystem-guard.js';
import { resolveWorkspaceFolderPath } from '../platform/workspace-folder.js';

const SANDBOX_RUNTIME_GO_DNS = 'netdns=go';

// Host env projection for the DeepAgents shell tool. Returns the enable flag the
// runner reads when (and only when) the run is a DeepAgents run that requests
// shell (RunCommand) authority AND is confined by an enforcing sandbox — derived
// from the SAME guard inputs as the pre-spawn admission check so host and runner
// agree. The pre-spawn guard already fails the spawn closed for shell authority
// without an enforcing sandbox, so this only flips to '1' on the allowed path.
export function deepAgentsShellEnabledEnv(
  input: DeepAgentsShellFilesystemGuardInput,
): Record<string, string> {
  return deepAgentsShellToolEnabled(input)
    ? { GANTRY_DEEPAGENTS_SHELL_ENABLED: '1' }
    : {};
}

export function deepAgentsFilesystemEnabledEnv(
  input: DeepAgentsShellFilesystemGuardInput,
): Record<string, string> {
  return deepAgentsFilesystemToolsEnabled(input)
    ? { GANTRY_DEEPAGENTS_FILESYSTEM_ENABLED: '1' }
    : {};
}

export type RunnerAgentInput = Omit<AgentInput, 'toolPolicyRules'> & {
  allowedTools?: string[];
  modelCredentialEnv?: Record<string, string>;
  toolNetworkEnv?: Record<string, string>;
  deepAgentCheckpointer?: {
    databaseUrl: string;
    schema: string;
    proxyUrl?: string;
  };
};
export function buildBaseRunnerEnv(input: {
  hostEnv: NodeJS.ProcessEnv;
  preparedEnv: NodeJS.ProcessEnv;
  runnerToolProcessEnv: Record<string, string>;
  runnerTempDir?: string;
  preparedTempEnv?: NodeJS.ProcessEnv;
  timezone: string;
  mcpServerPath: string;
  hostRuntimeGroupDir: string;
  workspaceKey: string;
  runnerAppId: string;
  agentId?: string;
  processName: string;
  workspaceExtraDir: string;
  workspaceIpcDir: string;
  ipcInputDir: string;
  ipcAuthToken: string;
  chatJid: string;
  jobId?: string;
  jobName?: string;
  runId?: string;
  parentTaskId?: string;
  runLeaseToken?: string;
  runLeaseFencingVersion?: number;
  browserIpcAuthToken?: string;
  memoryIpcAuthToken: string;
  memoryIpcAllowedActions: readonly string[];
  responseVerifyKey: string;
  responseKeyId: string;
  threadId?: string;
  memoryUserId?: string;
  memoryDefaultScope?: string;
  memoryReviewerIsControlApprover?: boolean;
  hideAuthorityTools: boolean;
  agentAccessPreset: string;
  deploymentMode: string;
  permissionTimeoutMs: number;
  egressProxyUrl: string;
  sandboxRuntimeProxy: boolean;
  deepAgentsShellEnv: Record<string, string>;
  deepAgentsFilesystemEnv: Record<string, string>;
  pickSafeHostEnv: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
  pickPreparedExecutionEnv: (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  return {
    ...input.pickSafeHostEnv(input.hostEnv),
    ...input.pickPreparedExecutionEnv(input.preparedEnv),
    ...input.runnerToolProcessEnv,
    ...(input.runnerTempDir
      ? {
          TMPDIR: input.runnerTempDir,
          TMP: input.runnerTempDir,
          TEMP: input.runnerTempDir,
          ...(input.preparedTempEnv ?? {}),
        }
      : {}),
    TZ: input.timezone,
    GANTRY_MCP_SERVER_PATH: input.mcpServerPath,
    GANTRY_WORKSPACE_GROUP_DIR: input.hostRuntimeGroupDir,
    GANTRY_WORKSPACE_GLOBAL_DIR: '',
    GANTRY_WORKSPACE_KEY: input.workspaceKey,
    GANTRY_APP_ID: input.runnerAppId,
    ...(input.agentId ? { GANTRY_AGENT_ID: input.agentId } : {}),
    GANTRY_AGENT_RUN_HANDLE: input.processName,
    GANTRY_WORKSPACE_EXTRA_DIR: input.workspaceExtraDir,
    GANTRY_IPC_DIR: input.workspaceIpcDir,
    GANTRY_IPC_INPUT_DIR: input.ipcInputDir,
    GANTRY_IPC_AUTH_TOKEN: input.ipcAuthToken,
    GANTRY_CHAT_JID: input.chatJid,
    ...(input.jobId ? { GANTRY_JOB_ID: input.jobId } : {}),
    ...(input.jobName ? { GANTRY_JOB_NAME: input.jobName } : {}),
    ...(input.runId ? { GANTRY_JOB_RUN_ID: input.runId } : {}),
    ...(input.parentTaskId
      ? { GANTRY_PARENT_TASK_ID: input.parentTaskId }
      : {}),
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
    ...(input.browserIpcAuthToken
      ? { GANTRY_BROWSER_IPC_AUTH_TOKEN: input.browserIpcAuthToken }
      : {}),
    GANTRY_MEMORY_IPC_AUTH_TOKEN: input.memoryIpcAuthToken,
    GANTRY_MEMORY_IPC_ACTIONS_JSON: JSON.stringify(
      input.memoryIpcAllowedActions,
    ),
    GANTRY_IPC_RESPONSE_VERIFY_KEY: input.responseVerifyKey,
    GANTRY_IPC_RESPONSE_KEY_ID: input.responseKeyId,
    GANTRY_THREAD_ID: input.threadId || '',
    GANTRY_MEMORY_USER_ID: input.memoryUserId || '',
    GANTRY_MEMORY_DEFAULT_SCOPE: input.memoryDefaultScope || 'group',
    GANTRY_MEMORY_REVIEWER_IS_CONTROL_APPROVER:
      input.memoryReviewerIsControlApprover ? '1' : '',
    GANTRY_NO_PERMISSION_TOOLS: input.hideAuthorityTools ? '1' : '',
    GANTRY_AGENT_ACCESS_PRESET: input.agentAccessPreset,
    GANTRY_DEPLOYMENT_MODE: input.deploymentMode,
    GANTRY_INTERACTIVE_PERMISSION_TIMEOUT_MS: String(input.permissionTimeoutMs),
    GANTRY_PERMISSION_TIMEOUT_MS: String(input.permissionTimeoutMs),
    GANTRY_EGRESS_PROXY_URL: input.egressProxyUrl,
    ...(input.sandboxRuntimeProxy ? { GANTRY_SANDBOX_RUNTIME_PROXY: '1' } : {}),
    ...input.deepAgentsShellEnv,
    ...input.deepAgentsFilesystemEnv,
  };
}
type WarnLogger = (metadata: Record<string, unknown>, message: string) => void;
type SandboxRuntimeGatewayOptions = {
  allowedNetworkHosts?: string[];
  privateNetworkHostMappings?: readonly EgressGatewayPrivateHostMapping[];
};

const NO_RUNNER_SANDBOX_WARM_TEMPLATE_STATUS: RunnerSandboxWarmTemplateStatus =
  {
    available: false,
    cacheHit: false,
    authorityFree: true,
  };

export function resolveRunnerSandboxStartup(input: {
  provider?: RunnerSandboxProvider;
  runtimeProvider: RunnerSandboxProviderId;
  measure: <T>(phase: 'sandboxTemplateMs', run: () => T) => T;
}): {
  runnerSandboxProviderId: RunnerSandboxProviderId;
  sandboxWarmTemplate: RunnerSandboxWarmTemplateStatus;
} {
  const runnerSandboxProviderId = input.provider?.id ?? 'direct';
  if (runnerSandboxProviderId !== input.runtimeProvider) {
    throw new Error(
      `Runner sandbox provider mismatch: settings.yaml has ${input.runtimeProvider}, but the live runtime provider is ${runnerSandboxProviderId}. Restart Gantry before running agents.`,
    );
  }
  return {
    runnerSandboxProviderId,
    sandboxWarmTemplate: input.measure(
      'sandboxTemplateMs',
      () =>
        input.provider?.warmTemplate?.() ??
        NO_RUNNER_SANDBOX_WARM_TEMPLATE_STATUS,
    ),
  };
}

export function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function prepareRunnerWorkspace(input: {
  folder: string;
  nowMs: () => number;
  warn: WarnLogger;
}): { groupDir: string; processName: string } {
  const groupDir = resolveWorkspaceFolderPath(input.folder);
  fs.mkdirSync(groupDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(groupDir, 0o700);
  } catch (err) {
    input.warn({ err, groupDir }, 'Failed to tighten agent workspace mode');
  }
  const safeName = input.folder.replace(/[^a-zA-Z0-9-]/g, '-');
  return {
    groupDir,
    processName: `gantry-${safeName}-${input.nowMs()}-${randomUUID().slice(0, 8)}`,
  };
}

export function cleanupRunnerMcpConfigFile(
  configPath: string | undefined,
  warn: WarnLogger,
): void {
  if (!configPath) return;
  try {
    fs.rmSync(configPath, { force: true });
  } catch (err) {
    warn({ err, configPath }, 'Failed to remove MCP runner handoff file');
  }
}

export function cleanupRunnerTempDir(
  dir: string | undefined,
  warn: WarnLogger,
): void {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (err) {
    warn({ err, dir }, 'Failed to remove runner temp directory');
  }
}

export function protectedWritePathsForOuterSandbox(
  protectedPaths: readonly string[],
  providerConfigDir: string | undefined,
): string[] {
  if (!providerConfigDir) return [...protectedPaths];
  const resolvedProviderConfigDir = path.resolve(providerConfigDir);
  return protectedPaths.flatMap((item) =>
    path.resolve(item) === resolvedProviderConfigDir
      ? [
          path.join(providerConfigDir, ['settings', 'json'].join('.')),
          path.join(providerConfigDir, ['settings', 'local', 'json'].join('.')),
          path.join(providerConfigDir, ['m', 'cp'].join('')),
          path.join(providerConfigDir, ['ski', 'lls'].join('')),
        ]
      : [item],
  );
}

export function sandboxRuntimeToolProcessEnv(
  providerId: string,
  toolNetworkEnv: Record<string, string>,
): Record<string, string> {
  if (providerId !== 'sandbox_runtime') return {};
  return sandboxRuntimeToolNetworkEnv(providerId, toolNetworkEnv);
}

export function sandboxRuntimeToolNetworkEnv(
  providerId: string,
  toolNetworkEnv: Record<string, string>,
): Record<string, string> {
  if (providerId !== 'sandbox_runtime') return toolNetworkEnv;
  return {
    ...toolNetworkEnv,
    GODEBUG: toolNetworkEnv.GODEBUG?.trim() || SANDBOX_RUNTIME_GO_DNS,
  };
}

export function buildSandboxRuntimeGatewayOptions(
  providerId: string,
  allowedNetworkHosts: readonly string[],
  modelCredentialEnv: Record<string, string> | undefined,
): {
  modelCredentialEnv: Record<string, string> | undefined;
  gatewayOptions: SandboxRuntimeGatewayOptions;
} {
  if (providerId !== 'sandbox_runtime') {
    return { modelCredentialEnv, gatewayOptions: {} };
  }
  const projection = projectSandboxRuntimeModelGatewayEnv(modelCredentialEnv);
  const mergedHosts =
    projection.allowedNetworkHosts.length > 0
      ? [
          ...new Set([
            ...allowedNetworkHosts,
            ...projection.allowedNetworkHosts,
          ]),
        ]
      : [...allowedNetworkHosts];
  return {
    modelCredentialEnv: projection.modelCredentialEnv,
    gatewayOptions: {
      allowedNetworkHosts: mergedHosts,
      ...(projection.privateNetworkHostMappings.length > 0
        ? { privateNetworkHostMappings: projection.privateNetworkHostMappings }
        : {}),
    },
  };
}

export function buildRunnerSandboxSpawnInput(input: {
  groupDir: string;
  sandboxConfigPath: string;
  egressProxyUrl?: string;
  allowedNetworkHosts: readonly string[];
  runnerPackageRoot: string;
  workspaceIpcDir: string;
  workspaceExtraDir: string;
  providerConfigDir?: string;
  runnerTempDir?: string;
  providerToolTempDir?: string;
  localCliCredentialPaths: readonly string[];
  mcpConfigPath?: string;
  protectedReadPaths: readonly string[];
  protectedWritePaths: readonly string[];
  resourceLimits: RunnerSandboxResourceLimits;
  principal: {
    appId: string;
    agentId?: string;
    conversationId: string;
    threadId?: string;
    runId?: string;
    jobId?: string;
  };
}): Omit<RunnerSandboxSpawnInput, 'command' | 'args' | 'env'> {
  return {
    cwd: input.groupDir,
    workspaceRoot: input.groupDir,
    configFilePath: input.sandboxConfigPath,
    egressProxyUrl: input.egressProxyUrl,
    allowedNetworkHosts: input.allowedNetworkHosts,
    runtimeReadPaths: [
      input.runnerPackageRoot,
      input.workspaceIpcDir,
      input.workspaceExtraDir,
      ...(input.providerConfigDir ? [input.providerConfigDir] : []),
      ...(input.runnerTempDir ? [input.runnerTempDir] : []),
      ...(input.providerToolTempDir ? [input.providerToolTempDir] : []),
      ...input.localCliCredentialPaths,
      ...(input.mcpConfigPath ? [input.mcpConfigPath] : []),
    ],
    runtimeWritePaths: [
      input.workspaceIpcDir,
      ...(input.providerConfigDir ? [input.providerConfigDir] : []),
      ...(input.runnerTempDir ? [input.runnerTempDir] : []),
      ...(input.providerToolTempDir ? [input.providerToolTempDir] : []),
    ],
    protectedReadPaths: input.protectedReadPaths,
    protectedWritePaths: input.protectedWritePaths,
    resourceLimits: input.resourceLimits,
    sandboxProfile: {
      id: 'runner-default',
      network: 'required',
      filesystem: 'workspace_write',
    },
    principal: input.principal,
  };
}

export function buildAndLogRunnerRuntimeDetails(input: {
  logger: {
    debug: (context: Record<string, unknown>, message: string) => void;
    info: (context: Record<string, unknown>, message: string) => void;
  };
  groupName: string;
  processName: string;
  command: string;
  args: readonly string[];
  groupDir: string;
  ipcInputDir: string;
  sandboxProviderId: string;
  sandboxEnforcing: boolean;
  brokerProfile: string;
  brokerApplied: boolean;
  mcpServerNames: readonly string[];
  browserProfileName: string;
  preparedRuntimeDetails: readonly string[];
  effectiveModel?: string;
  effectiveModelSource?: string;
  systemPromptChars: number;
}): string[] {
  const runtimeDetails = [
    `groupDir=${input.groupDir}`,
    'globalDir=(none)',
    `ipcInput=${input.ipcInputDir}`,
    `sandbox=${input.sandboxProviderId} enforcing=${input.sandboxEnforcing}`,
    `broker=${input.brokerProfile}`,
    `brokerApplied=${input.brokerApplied}`,
    `mcpServers=${input.mcpServerNames.join(',') || '(none)'}`,
    `browserProfile=${input.browserProfileName}`,
    ...input.preparedRuntimeDetails,
  ];
  input.logger.debug(
    {
      group: input.groupName,
      processName: input.processName,
      command: input.command,
      args: input.args.join(' '),
      runtimeDetails,
    },
    'Host agent runtime configuration',
  );
  input.logger.info(
    {
      group: input.groupName,
      processName: input.processName,
      model: input.effectiveModel ?? null,
      modelSource: input.effectiveModelSource,
      systemPromptChars: input.systemPromptChars,
    },
    'Spawning host agent',
  );
  return runtimeDetails;
}
