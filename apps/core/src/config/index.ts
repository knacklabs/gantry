import path from 'path';
import fs from 'fs';
import { resolveModelAlias } from '../shared/model-catalog.js';
import type { AppId } from '../domain/app/app.js';
import {
  AUTO_AGENT_HARNESS,
  type AgentHarness,
} from '../shared/agent-engine.js';
import { envConfig, envValue, envValueDynamic } from './env/index.js';
import { getMemoryModelConfig } from './memory.js';
import { getGantryHome } from '../shared/gantry-home.js';
import { resolveRuntimeStorageConfig } from './settings/storage.js';
import { ensureRuntimeSettings } from './settings/runtime-settings.js';
import {
  readRuntimeModelDefaults,
  updateRuntimeModelDefaults,
} from './settings/model-defaults.js';
import { settingsFilePath } from './settings/runtime-home.js';
import { DEFAULT_AGENT_NAME } from './settings/runtime-settings-defaults.js';
import type { RuntimeDeploymentMode } from '../shared/runtime-deployment-mode.js';
import type {
  AgentRuntime,
  RuntimeSettings,
} from './settings/runtime-settings-types.js';
import { resolveConfiguredAgentRuntime } from './settings/runtime-settings-agent-runtime.js';
import { isValidTimezone } from '../shared/timezone.js';
import { resolvePermissionApprovalTimeoutMs } from '../shared/permission-timeout.js';
import { effectiveYoloModeSettings } from '../shared/yolo-mode-policy.js';
import { resolveEffectivePermissionMode } from '../shared/permission-mode.js';
import {
  buildTriggerPattern,
  defaultTriggerForAgentName,
} from '../shared/trigger-pattern.js';
export * from './memory.js';
export { SettingsDesiredStateService } from './settings/desired-state-service.js';
export { configureDesiredSettingsStorageProvider } from './settings/runtime-settings.js';
export {
  applyRuntimeSettingsDesiredState,
  syncRuntimeSettingsFromProjection,
} from './settings/restart-sync.js';
export {
  createDefaultRuntimeSettings,
  loadRuntimeSettings,
  loadRuntimeSettingsFromPath,
} from './settings/runtime-settings.js';
export {
  resolveRuntimeBootstrapStorageConfigFromEnv,
  resolveRuntimeStorageConfig,
  resolveRuntimeStorageConfigFromSettings,
} from './settings/storage.js';
export type { RuntimeSettings } from './settings/runtime-settings-types.js';
export type ControlEnvKey =
  | 'GANTRY_CONTROL_API_KEYS_JSON'
  | 'GANTRY_CONTROL_HOST'
  | 'GANTRY_CONTROL_PORT'
  | 'GANTRY_CONTROL_SOCKET_PATH'
  | 'GANTRY_IPC_AUTH_SECRET'
  | 'GANTRY_SECURITY_POSTURE'
  | 'GANTRY_RUNTIME_ENV'
  | 'NODE_ENV'
  | 'REMOTE_CONTROL_AUTO_ACCEPT'
  | 'SECRET_ENCRYPTION_KEY'
  | 'SECRET_ENCRYPTION_KEYRING_JSON';
export function getControlEnvValue(key: ControlEnvKey): string {
  return envValueDynamic(key);
}
const GANTRY_HOME_RAW =
  process.env.GANTRY_HOME?.trim() || envConfig.GANTRY_HOME?.trim() || '';
export const GANTRY_HOME = getGantryHome(GANTRY_HOME_RAW);
export const RUNTIME_SETTINGS_PATH = settingsFilePath(GANTRY_HOME);
const RUNTIME_ROOT = GANTRY_HOME;
let runtimeSettingsCache:
  | {
      filePath: string;
      mtimeMs: number;
      size: number;
      settings: RuntimeSettings;
    }
  | undefined;
export function getRuntimeSettingsForConfig(): RuntimeSettings {
  const filePath = settingsFilePath(GANTRY_HOME);
  try {
    const stat = fs.statSync(filePath);
    if (
      runtimeSettingsCache?.filePath === filePath &&
      runtimeSettingsCache.mtimeMs === stat.mtimeMs &&
      runtimeSettingsCache.size === stat.size
    ) {
      return runtimeSettingsCache.settings;
    }
    const settings = ensureRuntimeSettings(GANTRY_HOME);
    runtimeSettingsCache = {
      filePath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      settings,
    };
    return settings;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    const settings = ensureRuntimeSettings(GANTRY_HOME);
    const stat = fs.statSync(filePath);
    runtimeSettingsCache = {
      filePath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      settings,
    };
    return settings;
  }
}
export function getConfiguredAgentName(): string {
  try {
    return (
      getRuntimeSettingsForConfig().agent.name.trim() || DEFAULT_AGENT_NAME
    );
  } catch {
    return DEFAULT_AGENT_NAME;
  }
}
export const ASSISTANT_NAME = getConfiguredAgentName();

function getPublicConfiguredAgents(settings: RuntimeSettings) {
  return Object.fromEntries(
    Object.entries(settings.agents).map(([agentId, agent]) => [
      agentId,
      {
        name: agent.name,
        folder: agent.folder,
        persona: agent.persona,
        relationshipMode: agent.relationshipMode,
        runtime: resolveConfiguredAgentRuntime(agent),
        model: agent.model,
        agentHarness: agent.agentHarness,
        permissionMode: agent.permissionMode,
        oneTimeJobDefaultModel: agent.oneTimeJobDefaultModel,
        recurringJobDefaultModel: agent.recurringJobDefaultModel,
        bindings: agent.bindings,
        sources: agent.sources,
        capabilities: agent.capabilities,
        access: {
          preset: agent.accessPreset,
        },
      },
    ]),
  );
}

function getPublicConfiguredConversations(settings: RuntimeSettings) {
  return Object.fromEntries(
    Object.entries(settings.conversations).map(([conversationId, entry]) => {
      const { providerConnection: _providerConnection, ...conversation } =
        entry;
      return [
        conversationId,
        { ...conversation, brainHarvest: conversation.brainHarvest ?? false },
      ];
    }),
  );
}

export function getPublicRuntimeSettings() {
  const settings = getRuntimeSettingsForConfig();
  return {
    desiredState: settings.desiredState,
    agent: {
      name: settings.agent.name,
      defaultModel: settings.agent.defaultModel,
      agentHarness: settings.agent.agentHarness,
      oneTimeJobDefaultModel: settings.agent.oneTimeJobDefaultModel,
      recurringJobDefaultModel: settings.agent.recurringJobDefaultModel,
    },
    agents: getPublicConfiguredAgents(settings),
    providers: settings.providers,
    providerAccounts: settings.providerAccounts,
    conversations: getPublicConfiguredConversations(settings),
    conversationInstalls: settings.conversationInstalls,
    bindings: settings.bindings,
    modelAliases: settings.modelAliases,
    memory: {
      enabled: settings.memory.enabled,
      dreaming: {
        enabled: settings.memory.dreaming.enabled,
      },
    },
    runtime: {
      queue: settings.runtime.queue,
      sandbox: settings.runtime.sandbox,
      artifactStore: settings.runtime.artifactStore,
      deploymentMode: settings.runtime.deploymentMode,
    },
    browser: {
      usage: {
        enabled: settings.browser.usage.enabled,
        mode: settings.browser.usage.mode,
        windowMs: settings.browser.usage.windowMs,
        maxActionsPerWindow: settings.browser.usage.maxActionsPerWindow,
        maxConcurrentPerSite: settings.browser.usage.maxConcurrentPerSite,
      },
    },
    permissions: {
      yoloMode: effectiveYoloModeSettings(settings.permissions.yoloMode),
      egress: settings.permissions.egress,
      autoMode: settings.permissions.autoMode,
    },
  };
}
export function getDeploymentMode(): RuntimeDeploymentMode {
  return getRuntimeSettingsForConfig().runtime.deploymentMode;
}
export function getRuntimeQueueConfig() {
  const queue = getRuntimeSettingsForConfig().runtime.queue;
  return {
    maxMessageRuns: queue.maxMessageRuns,
    maxJobRuns: queue.maxJobRuns,
    maxMessageBacklog: queue.maxMessageBacklog,
    maxTaskBacklog: queue.maxTaskBacklog,
    maxRetries: queue.maxRetries,
    baseRetryMs: queue.baseRetryMs,
    drainDeadlineMs: queue.drainDeadlineMs,
  };
}

export const STORE_DIR = path.resolve(RUNTIME_ROOT, 'store');
export const AGENTS_DIR = path.resolve(RUNTIME_ROOT, 'agents');
export const DATA_DIR = path.resolve(RUNTIME_ROOT, 'data');
export const ARTIFACTS_DIR = path.resolve(RUNTIME_ROOT, 'artifacts');
const runtimeStorageConfig = resolveRuntimeStorageConfig(
  GANTRY_HOME,
  RUNTIME_ROOT,
);
export const STORAGE_POSTGRES_URL_ENV = runtimeStorageConfig.postgresUrlEnv;
export const STORAGE_POSTGRES_URL = runtimeStorageConfig.postgresUrl;
export const STORAGE_POSTGRES_SCHEMA = runtimeStorageConfig.postgresSchema;
export const STORAGE_POSTGRES_PLAINTEXT_HOST_ALLOWLIST =
  runtimeStorageConfig.postgresPlaintextHostAllowlist;
export const PERMISSION_APPROVAL_TIMEOUT_MS =
  resolvePermissionApprovalTimeoutMs(process.env, envConfig);
export const AGENT_TIMEOUT = parseInt(
  process.env.AGENT_TIMEOUT || '1800000',
  10,
);
export const AGENT_MAX_OUTPUT_SIZE = parseInt(
  process.env.AGENT_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export function getCredentialBrokerRuntimeConfig(): {
  mode: RuntimeSettings['credentialBroker']['mode'];
  gatewayBindHost: string;
} {
  const settings = getRuntimeSettingsForConfig();
  return {
    mode: settings.credentialBroker.mode,
    gatewayBindHost: settings.credentialBroker.gateway.bindHost,
  };
}
export const SECRET_ENCRYPTION_KEY = envValue('SECRET_ENCRYPTION_KEY');
const normModel = resolveModelAlias;
export function getConfiguredDefaultModel(): string {
  return normModel(getRuntimeSettingsForConfig().agent.defaultModel) || '';
}
export const GANTRY_IPC_AUTH_SECRET = envValue('GANTRY_IPC_AUTH_SECRET');
export const LOG_LEVEL = envValue('LOG_LEVEL') || 'info';
export const HOST_CREDENTIAL_ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_MODEL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_DEFAULT_OPUS_MODEL',
  'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',
] as const;
type HostCredentialSource = Partial<Record<string, string | undefined>>;
function readHostCredentialValue(
  key: (typeof HOST_CREDENTIAL_ENV_KEYS)[number],
  source?: HostCredentialSource,
): string {
  return source?.[key]?.trim() || '';
}
export function getHostCredentialEnv(
  source?: HostCredentialSource,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of HOST_CREDENTIAL_ENV_KEYS) {
    const value = readHostCredentialValue(key, source);
    if (value) env[key] = value;
  }
  return env;
}
export type ClaudeAuthMode = 'broker' | 'none';
export interface ClaudeAuthState {
  hasOauthToken: boolean;
  hasApiKey: boolean;
  mode: ClaudeAuthMode;
}
export function resolveClaudeAuthState(): ClaudeAuthState {
  const brokerConfig = getCredentialBrokerRuntimeConfig();
  const credentialMode = brokerConfig.mode;
  return {
    hasOauthToken: false,
    hasApiKey: false,
    mode: credentialMode === 'gantry' ? 'broker' : 'none',
  };
}
export function getMemoryModelRuntimeConfig(): ReturnType<
  typeof getMemoryModelConfig
> {
  return getMemoryModelConfig(getConfiguredDefaultModel());
}
export type DefaultModelSource =
  | 'settings.yaml agents.<agent>.model'
  | 'settings.yaml agents.<agent>.one_time_job_default_model'
  | 'settings.yaml agents.<agent>.recurring_job_default_model'
  | 'settings.yaml agent.default_model'
  | 'system default';
export type EffectiveModelSource =
  | 'conversation.agentConfig.model'
  | 'job.model'
  | 'settings.yaml agent.one_time_job_default_model'
  | 'settings.yaml agent.recurring_job_default_model'
  | DefaultModelSource;
export type ModelUseKind = 'interactive' | 'oneTimeJob' | 'recurringJob';
export function getDefaultModelConfig(
  kind: ModelUseKind = 'interactive',
  agentFolder?: string,
):
  | {
      model?: string;
      source: DefaultModelSource;
    }
  | {
      model?: string;
      source:
        | 'settings.yaml agents.<agent>.one_time_job_default_model'
        | 'settings.yaml agents.<agent>.recurring_job_default_model'
        | 'settings.yaml agent.one_time_job_default_model'
        | 'settings.yaml agent.recurring_job_default_model';
    } {
  const settings = getRuntimeSettingsForConfig();
  const configuredAgent = agentFolder
    ? settings.agents[agentFolder]
    : undefined;
  if (kind === 'oneTimeJob') {
    const oneTimeAgentModel = normModel(
      configuredAgent?.oneTimeJobDefaultModel,
    );
    if (oneTimeAgentModel) {
      return {
        model: oneTimeAgentModel,
        source: 'settings.yaml agents.<agent>.one_time_job_default_model',
      };
    }
    const oneTimeModel = normModel(settings.agent.oneTimeJobDefaultModel);
    if (oneTimeModel) {
      return {
        model: oneTimeModel,
        source: 'settings.yaml agent.one_time_job_default_model',
      };
    }
  }
  if (kind === 'recurringJob') {
    const recurringAgentModel = normModel(
      configuredAgent?.recurringJobDefaultModel,
    );
    if (recurringAgentModel) {
      return {
        model: recurringAgentModel,
        source: 'settings.yaml agents.<agent>.recurring_job_default_model',
      };
    }
    const recurringModel = normModel(settings.agent.recurringJobDefaultModel);
    if (recurringModel) {
      return {
        model: recurringModel,
        source: 'settings.yaml agent.recurring_job_default_model',
      };
    }
  }
  const configuredAgentModel = normModel(configuredAgent?.model);
  if (configuredAgentModel) {
    return {
      model: configuredAgentModel,
      source: 'settings.yaml agents.<agent>.model',
    };
  }
  const configuredModel = normModel(settings.agent.defaultModel) || '';
  if (configuredModel) {
    return {
      model: configuredModel,
      source: 'settings.yaml agent.default_model',
    };
  }
  return { model: 'opus', source: 'system default' };
}

export function getRuntimeModelDefaults() {
  return readRuntimeModelDefaults({
    runtimeHome: GANTRY_HOME,
    getDefaultModelConfig,
  });
}

export function patchRuntimeModelDefaults(
  body: Record<string, unknown>,
  appId?: AppId,
  createdBy?: string,
  options?: {
    getConfiguredModelProviderIds?: () => Promise<ReadonlySet<string>>;
  },
) {
  return updateRuntimeModelDefaults({
    runtimeHome: GANTRY_HOME,
    body,
    appId,
    createdBy,
    getConfiguredModelProviderIds: options?.getConfiguredModelProviderIds,
  });
}
export function getEffectiveModelConfig(
  groupModel?: string,
  kind: ModelUseKind = 'interactive',
  agentFolder?: string,
): {
  model?: string;
  source: EffectiveModelSource;
} {
  const normalizedGroupModel = normModel(groupModel);
  if (normalizedGroupModel) {
    return {
      model: normalizedGroupModel,
      source: 'conversation.agentConfig.model',
    };
  }
  return getDefaultModelConfig(kind, agentFolder);
}

export function getSelectedAgentHarness(agentFolder?: string): AgentHarness {
  const settings = getRuntimeSettingsForConfig();
  const configuredAgent = agentFolder
    ? settings.agents[agentFolder]
    : undefined;
  return (
    configuredAgent?.agentHarness ??
    settings.agent.agentHarness ??
    AUTO_AGENT_HARNESS
  );
}

export function getSelectedAgentRuntime(agentFolder?: string): AgentRuntime {
  return getConfiguredAgentRuntime(agentFolder) ?? 'worker';
}

export function getSelectedAgentPermissionMode(agentFolder?: string) {
  const agent = agentFolder
    ? getRuntimeSettingsForConfig().agents[agentFolder]
    : undefined;
  return resolveEffectivePermissionMode(undefined, agent?.permissionMode);
}

export function getConfiguredAgentRuntime(
  agentFolder?: string,
): AgentRuntime | undefined {
  const settings = getRuntimeSettingsForConfig();
  const configuredAgent = agentFolder
    ? settings.agents[agentFolder]
    : undefined;
  if (!configuredAgent) return undefined;
  return resolveConfiguredAgentRuntime(configuredAgent);
}

export const MESSAGE_FETCH_PAGE_SIZE = Math.max(
  1,
  parseInt(process.env.MESSAGE_FETCH_PAGE_SIZE || '200', 10) || 200,
);
export const MAX_MESSAGES_PER_PROMPT = Math.max(
  1,
  parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep the agent run alive after last result
export const DEFAULT_TRIGGER = defaultTriggerForAgentName(ASSISTANT_NAME);
export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}
export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);
// Timezone for scheduler jobs, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [
    process.env.TZ,
    envConfig.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();
