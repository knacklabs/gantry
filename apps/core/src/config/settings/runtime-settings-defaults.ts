import '../../channels/register-builtins.js';

import { listChannelProviders } from '../../channels/provider-registry.js';
import { MEMORY_MODEL_DEFAULTS } from '../../models/claude-model-registry.js';
import {
  createDefaultControlAllowlist,
  type SenderControlAllowlistConfig,
} from './control-allowlist.js';
import {
  createDefaultSenderAllowlist,
  type SenderAllowlistConfig,
} from './sender-allowlist.js';
import type {
  MemoryModelProfile,
  RuntimeCredentialBrokerSettings,
  RuntimeAgentSettings,
  RuntimeChannelSettings,
  RuntimeMemoryLlmModels,
  RuntimeMemorySettings,
  RuntimeSettings,
  RuntimeStorageSettings,
} from './runtime-settings-types.js';

export const DEFAULT_STORAGE_POSTGRES_URL_ENV = 'MYCLAW_DATABASE_URL';
export const DEFAULT_STORAGE_POSTGRES_SCHEMA = 'myclaw';
export const DEFAULT_ONECLI_URL = 'http://localhost:10254';
export const DEFAULT_ONECLI_DATABASE_URL_ENV = 'ONECLI_DATABASE_URL';
export const DEFAULT_ONECLI_POSTGRES_SCHEMA = 'onecli';
export const DEFAULT_MEMORY_STORAGE_DIR = 'memory';
export const DEFAULT_EMBED_MODEL = 'text-embedding-3-large';
export const DEFAULT_AGENT_SESSION_RECENT_MESSAGE_LIMIT = 20;
export const DEFAULT_AGENT_SESSION_SUMMARY_AFTER_MESSAGES = 50;
export const DEFAULT_AGENT_SESSION_SUMMARY_AFTER_RUNS = 10;
export const DEFAULT_AGENT_SESSION_MAX_HYDRATED_CONTEXT_CHARS = 12_000;

const DEFAULT_MODEL_HAIKU = MEMORY_MODEL_DEFAULTS.extractor;
const DEFAULT_MODEL_SONNET = MEMORY_MODEL_DEFAULTS.dreaming;

const MEMORY_MODEL_PROFILES: Record<
  MemoryModelProfile,
  RuntimeMemoryLlmModels
> = {
  cheap: {
    extractor: DEFAULT_MODEL_HAIKU,
    dreaming: DEFAULT_MODEL_HAIKU,
    consolidation: DEFAULT_MODEL_HAIKU,
  },
  balanced: {
    extractor: DEFAULT_MODEL_HAIKU,
    dreaming: DEFAULT_MODEL_SONNET,
    consolidation: DEFAULT_MODEL_SONNET,
  },
  quality: {
    extractor: DEFAULT_MODEL_SONNET,
    dreaming: DEFAULT_MODEL_SONNET,
    consolidation: DEFAULT_MODEL_SONNET,
  },
};

export function getMemoryModelProfileDefaults(
  profile: MemoryModelProfile,
): RuntimeMemoryLlmModels {
  const selected = MEMORY_MODEL_PROFILES[profile];
  return {
    extractor: selected.extractor,
    dreaming: selected.dreaming,
    consolidation: selected.consolidation,
  };
}

export function createDefaultChannelSettings(
  enabled: boolean,
): RuntimeChannelSettings {
  return {
    enabled,
    senderAllowlist: createDefaultSenderAllowlist(),
    controlAllowlist: createDefaultControlAllowlist(),
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
    defaultModel: '',
    sessions: {
      recentMessageLimit: DEFAULT_AGENT_SESSION_RECENT_MESSAGE_LIMIT,
      summaryAfterMessages: DEFAULT_AGENT_SESSION_SUMMARY_AFTER_MESSAGES,
      summaryAfterRuns: DEFAULT_AGENT_SESSION_SUMMARY_AFTER_RUNS,
      maxHydratedContextChars: DEFAULT_AGENT_SESSION_MAX_HYDRATED_CONTEXT_CHARS,
    },
  };
  const credentialBroker: RuntimeCredentialBrokerSettings = {
    mode: 'onecli',
    onecli: {
      url: DEFAULT_ONECLI_URL,
      postgres: {
        urlEnv: DEFAULT_ONECLI_DATABASE_URL_ENV,
        schema: DEFAULT_ONECLI_POSTGRES_SCHEMA,
      },
    },
    external: {
      baseUrl: '',
    },
  };
  const memory: RuntimeMemorySettings = {
    enabled: true,
    embeddings: {
      enabled: false,
      provider: 'disabled',
      model: DEFAULT_EMBED_MODEL,
    },
    dreaming: {
      enabled: false,
    },
    llm: {
      models: getMemoryModelProfileDefaults('balanced'),
    },
  };
  return {
    channels: Object.fromEntries(
      listChannelProviders().map((provider) => [
        provider.id,
        createDefaultChannelSettings(false),
      ]),
    ),
    storage,
    agent,
    credentialBroker,
    memory,
  };
}

export function applyMemoryModelProfile(
  settings: RuntimeSettings,
  profile: MemoryModelProfile,
): void {
  settings.memory.llm.models = getMemoryModelProfileDefaults(profile);
}

export type {
  SenderAllowlistConfig,
  SenderControlAllowlistConfig,
  RuntimeChannelSettings,
  RuntimeCredentialBrokerSettings,
  RuntimeAgentSettings,
  RuntimeMemoryLlmModels,
  RuntimeMemorySettings,
  RuntimeSettings,
  RuntimeStorageSettings,
};
