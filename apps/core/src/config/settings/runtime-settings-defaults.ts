import '../../channels/register-builtins.js';

import { DEFAULT_AGENT_NAME } from '../../shared/default-agent.js';
import { listChannelProviders } from '../../channels/provider-registry.js';
import { MEMORY_MODEL_DEFAULT_ALIASES } from '../../shared/model-catalog.js';
import { type SenderControlAllowlistConfig } from './control-allowlist.js';
import { type SenderAllowlistConfig } from './sender-allowlist.js';
import type {
  MemoryModelProfile,
  RuntimeCredentialBrokerSettings,
  RuntimeAgentSettings,
  RuntimeMemoryLlmModels,
  RuntimeMemorySettings,
  RuntimeSettings,
  RuntimeStorageSettings,
} from './runtime-settings-types.js';

export { DEFAULT_AGENT_NAME } from '../../shared/default-agent.js';

export const DEFAULT_STORAGE_POSTGRES_URL_ENV = 'MYCLAW_DATABASE_URL';
export const DEFAULT_STORAGE_POSTGRES_SCHEMA = 'myclaw';
export const DEFAULT_ONECLI_URL = 'http://localhost:10254';
export const DEFAULT_ONECLI_DATABASE_URL_ENV = 'ONECLI_DATABASE_URL';
export const DEFAULT_ONECLI_POSTGRES_SCHEMA = 'onecli';
export const DEFAULT_MEMORY_STORAGE_DIR = 'memory';
export const DEFAULT_EMBED_MODEL = 'text-embedding-3-large';
export const DEFAULT_AGENT_SESSION_MEMORY_ITEM_LIMIT = 8;
export const DEFAULT_AGENT_SESSION_MAX_MEMORY_CONTEXT_CHARS = 12_000;

const DEFAULT_MODEL_HAIKU = MEMORY_MODEL_DEFAULT_ALIASES.extractor;
const DEFAULT_MODEL_SONNET = MEMORY_MODEL_DEFAULT_ALIASES.dreaming;

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
  const runtime: RuntimeSettings['runtime'] = {
    queue: {
      maxMessageRuns: 3,
      maxJobRuns: 4,
      maxRetries: 5,
      baseRetryMs: 5000,
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
  RuntimeCredentialBrokerSettings,
  RuntimeAgentSettings,
  RuntimeMemoryLlmModels,
  RuntimeMemorySettings,
  RuntimeSettings,
  RuntimeStorageSettings,
};
