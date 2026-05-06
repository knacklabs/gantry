import path from 'path';
import fs from 'fs';

import {
  resolveModelAlias,
  resolveModelSelection,
} from '../shared/model-catalog.js';
import {
  envConfig,
  envValue,
  envValueDynamic,
  runtimeEnvValue,
} from './env/index.js';
import { parseBooleanEnv } from './env/parse.js';
import { getMemoryModelConfig } from './memory.js';
import { getMyclawHome } from '../shared/myclaw-home.js';
import { resolveRuntimeStorageConfig } from './settings/storage.js';
import {
  ensureRuntimeSettings,
  saveRuntimeSettings,
} from './settings/runtime-settings.js';
import { settingsFilePath } from './settings/runtime-home.js';
import { DEFAULT_AGENT_NAME } from './settings/runtime-settings-defaults.js';
import type { RuntimeSettings } from './settings/runtime-settings-types.js';
import { isValidTimezone } from '../shared/timezone.js';

export * from './memory.js';

export const POLL_INTERVAL = 2000;

export type ControlEnvKey =
  | 'MYCLAW_CONTROL_API_KEYS_JSON'
  | 'MYCLAW_CONTROL_API_KEY'
  | 'MYCLAW_CONTROL_APP_ID'
  | 'MYCLAW_CONTROL_PORT'
  | 'MYCLAW_CONTROL_SOCKET_PATH';

export function getControlEnvValue(key: ControlEnvKey): string {
  return envValueDynamic(key);
}

const MYCLAW_HOME_RAW =
  process.env.MYCLAW_HOME?.trim() || envConfig.MYCLAW_HOME?.trim() || '';
export const MYCLAW_HOME = getMyclawHome(MYCLAW_HOME_RAW);
const RUNTIME_ROOT = MYCLAW_HOME;
let runtimeSettingsCache:
  | {
      filePath: string;
      mtimeMs: number;
      size: number;
      settings: RuntimeSettings;
    }
  | undefined;

export function getRuntimeSettingsForConfig(): RuntimeSettings {
  const filePath = settingsFilePath(MYCLAW_HOME);
  try {
    const stat = fs.statSync(filePath);
    if (
      runtimeSettingsCache?.filePath === filePath &&
      runtimeSettingsCache.mtimeMs === stat.mtimeMs &&
      runtimeSettingsCache.size === stat.size
    ) {
      return runtimeSettingsCache.settings;
    }
    const settings = ensureRuntimeSettings(MYCLAW_HOME);
    runtimeSettingsCache = {
      filePath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      settings,
    };
    return settings;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    const settings = ensureRuntimeSettings(MYCLAW_HOME);
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

export function getPublicRuntimeSettings() {
  const settings = getRuntimeSettingsForConfig();
  return {
    desiredState: settings.desiredState,
    agent: {
      name: settings.agent.name,
      defaultModel: settings.agent.defaultModel,
      oneTimeJobDefaultModel: settings.agent.oneTimeJobDefaultModel,
      recurringJobDefaultModel: settings.agent.recurringJobDefaultModel,
    },
    agents: settings.agents,
    providers: settings.providers,
    providerConnections: settings.providerConnections,
    conversations: settings.conversations,
    bindings: settings.bindings,
    memory: {
      enabled: settings.memory.enabled,
      dreaming: {
        enabled: settings.memory.dreaming.enabled,
      },
    },
    runtime: settings.runtime,
  };
}

export function getRuntimeQueueConfig() {
  const queue = getRuntimeSettingsForConfig().runtime.queue;
  return {
    maxMessageRuns: queue.maxMessageRuns,
    maxJobRuns: queue.maxJobRuns,
    maxRetries: queue.maxRetries,
    baseRetryMs: queue.baseRetryMs,
  };
}

export function updatePublicRuntimeSettings(patch: {
  agent?: {
    name?: string;
    defaultModel?: string;
    oneTimeJobDefaultModel?: string;
    recurringJobDefaultModel?: string;
  };
  memory?: { enabled?: boolean; dreaming?: { enabled?: boolean } };
}) {
  const settings = getRuntimeSettingsForConfig();
  const nextMemoryEnabled = patch.memory?.enabled ?? settings.memory.enabled;
  const nextDreamingEnabled =
    patch.memory?.dreaming?.enabled ?? settings.memory.dreaming.enabled;
  if (nextDreamingEnabled && !nextMemoryEnabled) {
    throw Object.assign(
      new Error('memory.dreaming.enabled requires memory.enabled=true.'),
      {
        statusCode: 400,
        code: 'INVALID_REQUEST',
      },
    );
  }
  const changed: string[] = [];
  if (patch.agent?.name !== undefined) {
    const next = patch.agent.name.trim();
    if (settings.agent.name !== next) {
      settings.agent.name = next;
      changed.push('agent.name');
    }
  }
  if (patch.agent?.defaultModel !== undefined) {
    const next = normalizeSettingsModelPatch(
      patch.agent.defaultModel,
      'agent.defaultModel',
    );
    if (settings.agent.defaultModel !== next) {
      settings.agent.defaultModel = next;
      changed.push('agent.defaultModel');
    }
  }
  if (patch.agent?.oneTimeJobDefaultModel !== undefined) {
    const next = normalizeSettingsModelPatch(
      patch.agent.oneTimeJobDefaultModel,
      'agent.oneTimeJobDefaultModel',
    );
    if (settings.agent.oneTimeJobDefaultModel !== next) {
      settings.agent.oneTimeJobDefaultModel = next;
      changed.push('agent.oneTimeJobDefaultModel');
    }
  }
  if (patch.agent?.recurringJobDefaultModel !== undefined) {
    const next = normalizeSettingsModelPatch(
      patch.agent.recurringJobDefaultModel,
      'agent.recurringJobDefaultModel',
    );
    if (settings.agent.recurringJobDefaultModel !== next) {
      settings.agent.recurringJobDefaultModel = next;
      changed.push('agent.recurringJobDefaultModel');
    }
  }
  if (
    patch.memory?.enabled !== undefined &&
    settings.memory.enabled !== patch.memory.enabled
  ) {
    settings.memory.enabled = patch.memory.enabled;
    changed.push('memory.enabled');
  }
  if (
    patch.memory?.dreaming?.enabled !== undefined &&
    settings.memory.dreaming.enabled !== patch.memory.dreaming.enabled
  ) {
    settings.memory.dreaming.enabled = patch.memory.dreaming.enabled;
    changed.push('memory.dreaming.enabled');
  }
  if (changed.length > 0) {
    saveRuntimeSettings(MYCLAW_HOME, settings);
    runtimeSettingsCache = undefined;
  }
  return {
    settings: getPublicRuntimeSettings(),
    changed,
    restartRequired: changed.length > 0,
  };
}

function normalizeSettingsModelPatch(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const resolved = resolveModelSelection(trimmed);
  if (!resolved.ok) {
    throw Object.assign(new Error(`${field}: ${resolved.message}`), {
      statusCode: 400,
      code: 'INVALID_REQUEST',
    });
  }
  return resolved.alias;
}

export const STORE_DIR = path.resolve(RUNTIME_ROOT, 'store');
export const AGENTS_DIR = path.resolve(RUNTIME_ROOT, 'agents');
export const DATA_DIR = path.resolve(RUNTIME_ROOT, 'data');
export const ARTIFACTS_DIR = path.resolve(RUNTIME_ROOT, 'artifacts');

const runtimeStorageConfig = resolveRuntimeStorageConfig(
  MYCLAW_HOME,
  RUNTIME_ROOT,
);
export const STORAGE_POSTGRES_URL_ENV = runtimeStorageConfig.postgresUrlEnv;
export const STORAGE_POSTGRES_URL = runtimeStorageConfig.postgresUrl;
export const STORAGE_POSTGRES_SCHEMA = runtimeStorageConfig.postgresSchema;
export const PERMISSION_APPROVAL_TIMEOUT_MS = Math.max(
  10_000,
  parseInt(
    process.env.PERMISSION_APPROVAL_TIMEOUT_MS ||
      envConfig.PERMISSION_APPROVAL_TIMEOUT_MS ||
      '300000',
    10,
  ) || 300_000,
);
function collectConversationApproverAllowlist(
  providerId: string,
  sourceAgentFolder?: string,
): Set<string> {
  const runtimeSettings = getRuntimeSettingsForConfig();
  const approvers = Object.values(runtimeSettings.bindings)
    .filter(
      (binding) => !sourceAgentFolder || binding.agent === sourceAgentFolder,
    )
    .flatMap((binding) => {
      const conversation = runtimeSettings.conversations[binding.conversation];
      if (!conversation) return [];
      const connection =
        runtimeSettings.providerConnections[conversation.providerConnection];
      return connection?.provider === providerId
        ? conversation.controlApprovers
        : [];
    });
  return new Set(approvers.filter((entry) => entry.trim().length > 0));
}
export function getSlackPermissionApproverIds(
  sourceAgentFolder?: string,
): Set<string> {
  return collectConversationApproverAllowlist('slack', sourceAgentFolder);
}
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
  onecliUrl: string;
  externalBrokerBaseUrl: string;
} {
  const settings = getRuntimeSettingsForConfig();
  return {
    mode: settings.credentialBroker.mode,
    onecliUrl: settings.credentialBroker.onecli.url,
    externalBrokerBaseUrl: settings.credentialBroker.external.baseUrl,
  };
}

export const ONECLI_DATABASE_URL = envValue('ONECLI_DATABASE_URL');
export const ONECLI_SECRET_ENCRYPTION_KEY = envValue('SECRET_ENCRYPTION_KEY');
const normModel = resolveModelAlias;
export function getConfiguredDefaultModel(): string {
  return normModel(getRuntimeSettingsForConfig().agent.defaultModel) || '';
}
export const TELEGRAM_BOT_TOKEN = envValue('TELEGRAM_BOT_TOKEN');
export const SLACK_BOT_TOKEN = envValue('SLACK_BOT_TOKEN');
export const SLACK_APP_TOKEN = envValue('SLACK_APP_TOKEN');
export const MYCLAW_IPC_AUTH_SECRET = envValue('MYCLAW_IPC_AUTH_SECRET');
export const REMOTE_CONTROL_AUTO_ACCEPT = parseBooleanEnv(
  envValue('REMOTE_CONTROL_AUTO_ACCEPT'),
  false,
);
export const CHROME_PATH = envValue('CHROME_PATH') || undefined;
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
export const ONECLI_ALLOWED_ENV_KEYS = ['ANTHROPIC_BASE_URL'] as const;
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
export function getTelegramBotToken(): string {
  return runtimeEnvValue('TELEGRAM_BOT_TOKEN');
}
export function getSlackBotToken(): string {
  return runtimeEnvValue('SLACK_BOT_TOKEN');
}
export function getSlackAppToken(): string {
  return runtimeEnvValue('SLACK_APP_TOKEN');
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
  const configured =
    (credentialMode === 'onecli' && Boolean(brokerConfig.onecliUrl.trim())) ||
    (credentialMode === 'external' &&
      Boolean(brokerConfig.externalBrokerBaseUrl.trim()));
  return {
    hasOauthToken: false,
    hasApiKey: false,
    mode: configured ? 'broker' : 'none',
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
  | 'group.agentConfig.model'
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
      source: 'group.agentConfig.model',
    };
  }
  return getDefaultModelConfig(kind, agentFolder);
}

export const MAX_MESSAGES_PER_PROMPT = Math.max(
  1,
  parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep the agent run alive after last result

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

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
