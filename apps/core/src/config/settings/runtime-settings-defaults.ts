import '../../channels/register-builtins.js';

import { DEFAULT_AGENT_NAME } from '../../shared/default-agent.js';
import { listChannelProviders } from '../../channels/provider-registry.js';
import {
  DEFAULT_MODEL_PRESET_ID,
  getModelPreset,
  type ModelPresetId,
} from '../../shared/model-catalog.js';
import { type SenderControlAllowlistConfig } from './control-allowlist.js';
import { type SenderAllowlistConfig } from './sender-allowlist.js';
import type {
  RuntimeCredentialBrokerSettings,
  RuntimeAgentSettings,
  RuntimeBrowserSettings,
  RuntimeMemoryBackfillSettings,
  RuntimeMemoryLlmModels,
  RuntimeMemorySettings,
  RuntimePermissionSettings,
  RuntimeSandboxSettings,
  RuntimeSettings,
  RuntimeStorageSettings,
} from './runtime-settings-types.js';

export { DEFAULT_AGENT_NAME } from '../../shared/default-agent.js';

export const DEFAULT_STORAGE_POSTGRES_URL_ENV = 'GANTRY_DATABASE_URL';
export const DEFAULT_STORAGE_POSTGRES_SCHEMA = 'gantry';
export const DEFAULT_MODEL_GATEWAY_BIND_HOST = '127.0.0.1';
export const DEFAULT_EMBED_MODEL = 'text-embedding-3-small';
export const DEFAULT_EMBED_DIMENSIONS = 1536;
export const DEFAULT_OPENAI_DAILY_EMBED_LIMIT = 500;
export const DEFAULT_MEMORY_EXTRACTOR_MAX_FACTS = 8;
export const DEFAULT_MEMORY_EXTRACTOR_MIN_CONFIDENCE = 0.6;
export const DEFAULT_MEMORY_DREAMING_CRON = '15 3 * * *';
export const DEFAULT_MEMORY_EMBED_BATCH_SIZE = 16;
export const DEFAULT_MEMORY_MAINTENANCE_MAX_PENDING = 5_000;
export const DEFAULT_MEMORY_BACKFILL_ENABLED = true;
export const DEFAULT_MEMORY_BACKFILL_CRON = '45 3 * * *';
export const DEFAULT_MEMORY_BACKFILL_MAX_ITEMS_PER_RUN = 500;
export const DEFAULT_MEMORY_BACKFILL_MODE = 'auto';
export const DEFAULT_MEMORY_BACKFILL_PROVIDER_BATCH_MIN_ITEMS = 100;
export const DEFAULT_AGENT_SESSION_MEMORY_ITEM_LIMIT = 8;
export const DEFAULT_AGENT_SESSION_MAX_MEMORY_CONTEXT_CHARS = 12_000;
export const DEFAULT_BROWSER_USAGE_ENABLED = false;
export const DEFAULT_BROWSER_USAGE_MODE = 'audit';
export const DEFAULT_BROWSER_USAGE_WINDOW_MS = 60_000;
export const DEFAULT_BROWSER_USAGE_MAX_ACTIONS_PER_WINDOW = 120;
export const DEFAULT_BROWSER_USAGE_MAX_CONCURRENT_PER_SITE = 1;
export const DEFAULT_RUNTIME_SANDBOX_PROVIDER = 'direct';
export const DEFAULT_RUNTIME_DEPLOYMENT_MODE = 'workstation';

export function getDefaultRuntimeSandboxSettings(): RuntimeSandboxSettings {
  return {
    provider: DEFAULT_RUNTIME_SANDBOX_PROVIDER,
    resourceLimits: {
      cpuSeconds: 0,
      memoryMb: 0,
      maxProcesses: 0,
    },
  };
}

export function getDefaultMemoryBackfillSettings(): RuntimeMemoryBackfillSettings {
  return {
    enabled: DEFAULT_MEMORY_BACKFILL_ENABLED,
    cron: DEFAULT_MEMORY_BACKFILL_CRON,
    maxItemsPerRun: DEFAULT_MEMORY_BACKFILL_MAX_ITEMS_PER_RUN,
    mode: DEFAULT_MEMORY_BACKFILL_MODE,
    providerBatchMinItems: DEFAULT_MEMORY_BACKFILL_PROVIDER_BATCH_MIN_ITEMS,
  };
}

export function getPresetManagedMemoryDefaults(
  presetId: ModelPresetId = DEFAULT_MODEL_PRESET_ID,
): RuntimeMemoryLlmModels {
  const selected = getModelPreset(presetId).memoryDefaults;
  return {
    extractor: selected.extractor,
    dreaming: selected.dreaming,
    consolidation: selected.consolidation,
  };
}

export function createDefaultRuntimeSettings(): RuntimeSettings {
  const storage: RuntimeStorageSettings = {
    postgres: {
      urlEnv: DEFAULT_STORAGE_POSTGRES_URL_ENV,
      schema: DEFAULT_STORAGE_POSTGRES_SCHEMA,
    },
  };
  const agent: RuntimeAgentSettings = {
    name: DEFAULT_AGENT_NAME,
    defaultModel: '',
    oneTimeJobDefaultModel: '',
    recurringJobDefaultModel: '',
    sessions: {
      memoryItemLimit: DEFAULT_AGENT_SESSION_MEMORY_ITEM_LIMIT,
      maxMemoryContextChars: DEFAULT_AGENT_SESSION_MAX_MEMORY_CONTEXT_CHARS,
    },
  };
  const credentialBroker: RuntimeCredentialBrokerSettings = {
    mode: 'gantry',
    gateway: {
      bindHost: DEFAULT_MODEL_GATEWAY_BIND_HOST,
    },
  };
  const memory: RuntimeMemorySettings = {
    enabled: true,
    embeddings: {
      enabled: false,
      provider: 'disabled',
      model: DEFAULT_EMBED_MODEL,
      dimensions: DEFAULT_EMBED_DIMENSIONS,
      dailyLimit: DEFAULT_OPENAI_DAILY_EMBED_LIMIT,
      batchSize: DEFAULT_MEMORY_EMBED_BATCH_SIZE,
      backfill: getDefaultMemoryBackfillSettings(),
    },
    dreaming: {
      enabled: false,
      cron: DEFAULT_MEMORY_DREAMING_CRON,
      embeddings: {
        enabled: false,
        provider: 'disabled',
        model: DEFAULT_EMBED_MODEL,
      },
    },
    llm: {
      models: getPresetManagedMemoryDefaults(),
      extractorMaxFacts: DEFAULT_MEMORY_EXTRACTOR_MAX_FACTS,
      extractorMinConfidence: DEFAULT_MEMORY_EXTRACTOR_MIN_CONFIDENCE,
    },
    maintenance: {
      maxPending: DEFAULT_MEMORY_MAINTENANCE_MAX_PENDING,
    },
  };
  const runtime: RuntimeSettings['runtime'] = {
    queue: {
      maxMessageRuns: 3,
      maxJobRuns: 4,
      maxMessageBacklog: 0,
      maxTaskBacklog: 0,
      maxRetries: 5,
      baseRetryMs: 5000,
      drainDeadlineMs: 120000,
    },
    liveTurns: {
      enabled: true,
    },
    sandbox: getDefaultRuntimeSandboxSettings(),
    artifactStore: {
      driver: 'local',
    },
    deploymentMode: DEFAULT_RUNTIME_DEPLOYMENT_MODE,
  };
  const browser: RuntimeBrowserSettings = {
    usage: {
      enabled: DEFAULT_BROWSER_USAGE_ENABLED,
      mode: DEFAULT_BROWSER_USAGE_MODE,
      windowMs: DEFAULT_BROWSER_USAGE_WINDOW_MS,
      maxActionsPerWindow: DEFAULT_BROWSER_USAGE_MAX_ACTIONS_PER_WINDOW,
      maxConcurrentPerSite: DEFAULT_BROWSER_USAGE_MAX_CONCURRENT_PER_SITE,
      overrides: {},
    },
  };
  const permissions: RuntimePermissionSettings = {
    yoloMode: {
      enabled: true,
      denylist: [],
      denylistPaths: [],
    },
    egress: {
      denylist: [],
    },
  };
  return {
    desiredState: {
      authoritative: false,
    },
    providers: Object.fromEntries(
      listChannelProviders().map((provider) => [
        provider.id,
        { enabled: false, defaultConnection: undefined },
      ]),
    ),
    providerConnections: {},
    conversations: {},
    bindings: {},
    agents: {},
    storage,
    agent,
    credentialBroker,
    memory,
    runtime,
    browser,
    permissions,
  };
}

export function applyPresetManagedMemoryDefaults(
  settings: RuntimeSettings,
  presetId: ModelPresetId = DEFAULT_MODEL_PRESET_ID,
): void {
  settings.memory.llm.models = getPresetManagedMemoryDefaults(presetId);
}

export function applyModelPreset(
  settings: RuntimeSettings,
  presetId: ModelPresetId,
): void {
  const preset = getModelPreset(presetId);
  settings.agent.defaultModel = preset.chatDefault;
  settings.agent.oneTimeJobDefaultModel = preset.oneTimeJobDefault;
  settings.agent.recurringJobDefaultModel = preset.recurringJobDefault;
  applyPresetManagedMemoryDefaults(settings, presetId);
}

export type {
  SenderAllowlistConfig,
  SenderControlAllowlistConfig,
  RuntimeCredentialBrokerSettings,
  RuntimeAgentSettings,
  RuntimeMemoryLlmModels,
  RuntimeMemorySettings,
  RuntimePermissionSettings,
  RuntimeSettings,
  RuntimeStorageSettings,
};
