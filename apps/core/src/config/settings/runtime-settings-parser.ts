import {
  getChannelProvider,
  listChannelProviders,
} from '../../channels/provider-registry.js';
import { parseSenderControlAllowlistConfig } from './control-allowlist.js';
import { parseSenderAllowlistConfig } from './sender-allowlist.js';
import { parseSimpleYamlObject } from './yaml.js';
import {
  createDefaultChannelSettings,
  DEFAULT_AGENT_SESSION_MAX_HYDRATED_CONTEXT_CHARS,
  DEFAULT_AGENT_SESSION_RECENT_MESSAGE_LIMIT,
  DEFAULT_AGENT_SESSION_SUMMARY_AFTER_MESSAGES,
  DEFAULT_AGENT_SESSION_SUMMARY_AFTER_RUNS,
  DEFAULT_AGENT_NAME,
  DEFAULT_EMBED_MODEL,
  DEFAULT_ONECLI_URL,
  DEFAULT_ONECLI_DATABASE_URL_ENV,
  DEFAULT_ONECLI_POSTGRES_SCHEMA,
  DEFAULT_STORAGE_POSTGRES_SCHEMA,
  DEFAULT_STORAGE_POSTGRES_URL_ENV,
  getMemoryModelProfileDefaults,
} from './runtime-settings-defaults.js';
import type {
  EmbeddingProviderName,
  RuntimeCredentialBrokerSettings,
  RuntimeCredentialBrokerMode,
  RuntimeAgentSettings,
  RuntimeChannelSettings,
  RuntimeMemoryLlmModels,
  RuntimeMemorySettings,
  RuntimeSettings,
  RuntimeStorageSettings,
} from './runtime-settings-types.js';

function parseChannelSettings(
  raw: unknown,
  pathPrefix: string,
): RuntimeChannelSettings {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${pathPrefix} must be a mapping`);
  }

  const channelMap = raw as Record<string, unknown>;
  if (typeof channelMap.enabled !== 'boolean') {
    throw new Error(`${pathPrefix}.enabled must be true/false`);
  }

  return {
    enabled: channelMap.enabled,
    senderAllowlist: parseSenderAllowlistConfig(
      channelMap.sender_allowlist,
      `${pathPrefix}.sender_allowlist`,
    ),
    controlAllowlist: parseSenderControlAllowlistConfig(
      channelMap.control_allowlist,
      `${pathPrefix}.control_allowlist`,
    ),
  };
}

function parseStringValue(
  raw: unknown,
  pathPrefix: string,
  fallback?: string,
): string {
  if (raw === undefined && fallback !== undefined) return fallback;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error(`${pathPrefix} must be a non-empty string`);
  }
  return raw.trim();
}

function parseBooleanValue(
  raw: unknown,
  pathPrefix: string,
  fallback?: boolean,
): boolean {
  if (raw === undefined && fallback !== undefined) return fallback;
  if (typeof raw !== 'boolean') {
    throw new Error(`${pathPrefix} must be true/false`);
  }
  return raw;
}

function parsePositiveIntegerValue(
  raw: unknown,
  pathPrefix: string,
  fallback: number,
): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    throw new Error(`${pathPrefix} must be a positive integer`);
  }
  return raw;
}

function parseEmbeddingProvider(
  raw: unknown,
  pathPrefix: string,
): EmbeddingProviderName {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error(`${pathPrefix} must be a non-empty provider id`);
  }
  const value = raw.trim();
  if (!/^[a-z][a-z0-9_-]{0,62}$/.test(value)) {
    throw new Error(
      `${pathPrefix} must be a lowercase provider id such as disabled or openai`,
    );
  }
  return value;
}

function parsePostgresSchema(
  raw: unknown,
  pathPrefix: string,
  fallback = DEFAULT_STORAGE_POSTGRES_SCHEMA,
): string {
  const value = parseStringValue(raw, pathPrefix, fallback);
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) {
    throw new Error(
      `${pathPrefix} must be a lowercase PostgreSQL schema identifier`,
    );
  }
  return value;
}

function parseCredentialBrokerMode(
  raw: unknown,
  fallback: RuntimeCredentialBrokerMode,
): RuntimeCredentialBrokerMode {
  const value = parseStringValue(raw, 'credential_broker.mode', fallback);
  if (value === 'none' || value === 'onecli' || value === 'external') {
    return value;
  }
  throw new Error(
    'credential_broker.mode must be one of none, onecli, external',
  );
}

function parseCredentialBrokerSettings(
  raw: unknown,
): RuntimeCredentialBrokerSettings {
  const defaultSettings: RuntimeCredentialBrokerSettings = {
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
  if (raw === undefined) return defaultSettings;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('credential_broker must be a mapping');
  }
  const map = raw as Record<string, unknown>;
  for (const key of Object.keys(map)) {
    if (key !== 'mode' && key !== 'onecli' && key !== 'external') {
      throw new Error(
        `credential_broker.${key} is not supported. Configure credential_broker.mode, onecli.*, or external.*.`,
      );
    }
  }
  const mode = parseCredentialBrokerMode(map.mode, defaultSettings.mode);
  const onecliRaw = map.onecli;
  if (
    onecliRaw !== undefined &&
    (typeof onecliRaw !== 'object' ||
      onecliRaw === null ||
      Array.isArray(onecliRaw))
  ) {
    throw new Error('credential_broker.onecli must be a mapping');
  }
  const onecli = (onecliRaw || {}) as Record<string, unknown>;
  for (const key of Object.keys(onecli)) {
    if (key !== 'url' && key !== 'postgres') {
      throw new Error(
        `credential_broker.onecli.${key} is not supported. Configure credential_broker.onecli.url or postgres.*.`,
      );
    }
  }
  const postgresRaw = onecli.postgres;
  if (
    postgresRaw !== undefined &&
    (typeof postgresRaw !== 'object' ||
      postgresRaw === null ||
      Array.isArray(postgresRaw))
  ) {
    throw new Error('credential_broker.onecli.postgres must be a mapping');
  }
  const postgres = (postgresRaw || {}) as Record<string, unknown>;
  for (const key of Object.keys(postgres)) {
    if (key !== 'url_env' && key !== 'schema') {
      throw new Error(
        `credential_broker.onecli.postgres.${key} is not supported. Configure url_env or schema.`,
      );
    }
  }
  const externalRaw = map.external;
  if (
    externalRaw !== undefined &&
    (typeof externalRaw !== 'object' ||
      externalRaw === null ||
      Array.isArray(externalRaw))
  ) {
    throw new Error('credential_broker.external must be a mapping');
  }
  const external = (externalRaw || {}) as Record<string, unknown>;
  for (const key of Object.keys(external)) {
    if (key !== 'base_url') {
      throw new Error(
        `credential_broker.external.${key} is not supported. Configure base_url.`,
      );
    }
  }

  return {
    mode,
    onecli: {
      url:
        onecli.url === undefined
          ? DEFAULT_ONECLI_URL
          : typeof onecli.url === 'string'
            ? onecli.url.trim()
            : parseStringValue(onecli.url, 'credential_broker.onecli.url'),
      postgres: {
        urlEnv: parseStringValue(
          postgres.url_env,
          'credential_broker.onecli.postgres.url_env',
          DEFAULT_ONECLI_DATABASE_URL_ENV,
        ),
        schema: parsePostgresSchema(
          postgres.schema,
          'credential_broker.onecli.postgres.schema',
          DEFAULT_ONECLI_POSTGRES_SCHEMA,
        ),
      },
    },
    external: {
      baseUrl:
        external.base_url === undefined
          ? ''
          : typeof external.base_url === 'string'
            ? external.base_url.trim()
            : parseStringValue(
                external.base_url,
                'credential_broker.external.base_url',
              ),
    },
  };
}

function parseAgentSettings(raw: unknown): RuntimeAgentSettings {
  if (raw === undefined) {
    return {
      name: DEFAULT_AGENT_NAME,
      defaultModel: '',
      sessions: {
        recentMessageLimit: DEFAULT_AGENT_SESSION_RECENT_MESSAGE_LIMIT,
        summaryAfterMessages: DEFAULT_AGENT_SESSION_SUMMARY_AFTER_MESSAGES,
        summaryAfterRuns: DEFAULT_AGENT_SESSION_SUMMARY_AFTER_RUNS,
        maxHydratedContextChars:
          DEFAULT_AGENT_SESSION_MAX_HYDRATED_CONTEXT_CHARS,
      },
    };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('agent must be a mapping');
  }
  const map = raw as Record<string, unknown>;
  for (const key of Object.keys(map)) {
    if (key !== 'name' && key !== 'default_model' && key !== 'sessions') {
      throw new Error(
        `agent.${key} is not supported. Configure agent.name, agent.default_model, or agent.sessions.*.`,
      );
    }
  }
  const sessionsRaw = map.sessions;
  if (
    sessionsRaw !== undefined &&
    (typeof sessionsRaw !== 'object' ||
      sessionsRaw === null ||
      Array.isArray(sessionsRaw))
  ) {
    throw new Error('agent.sessions must be a mapping');
  }
  const sessions = (sessionsRaw || {}) as Record<string, unknown>;
  for (const key of Object.keys(sessions)) {
    if (
      key !== 'recent_message_limit' &&
      key !== 'summary_after_messages' &&
      key !== 'summary_after_runs' &&
      key !== 'max_hydrated_context_chars'
    ) {
      throw new Error(
        `agent.sessions.${key} is not supported. Configure recent_message_limit, summary_after_messages, summary_after_runs, or max_hydrated_context_chars.`,
      );
    }
  }
  return {
    name: parseStringValue(map.name, 'agent.name', DEFAULT_AGENT_NAME),
    defaultModel:
      map.default_model === undefined
        ? ''
        : typeof map.default_model === 'string'
          ? map.default_model.trim()
          : parseStringValue(map.default_model, 'agent.default_model'),
    sessions: {
      recentMessageLimit: parsePositiveIntegerValue(
        sessions.recent_message_limit,
        'agent.sessions.recent_message_limit',
        DEFAULT_AGENT_SESSION_RECENT_MESSAGE_LIMIT,
      ),
      summaryAfterMessages: parsePositiveIntegerValue(
        sessions.summary_after_messages,
        'agent.sessions.summary_after_messages',
        DEFAULT_AGENT_SESSION_SUMMARY_AFTER_MESSAGES,
      ),
      summaryAfterRuns: parsePositiveIntegerValue(
        sessions.summary_after_runs,
        'agent.sessions.summary_after_runs',
        DEFAULT_AGENT_SESSION_SUMMARY_AFTER_RUNS,
      ),
      maxHydratedContextChars: parsePositiveIntegerValue(
        sessions.max_hydrated_context_chars,
        'agent.sessions.max_hydrated_context_chars',
        DEFAULT_AGENT_SESSION_MAX_HYDRATED_CONTEXT_CHARS,
      ),
    },
  };
}

function parseStorageSettings(raw: unknown): RuntimeStorageSettings {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('storage must be a mapping');
  }
  const map = raw as Record<string, unknown>;
  for (const key of Object.keys(map)) {
    if (key !== 'postgres') {
      throw new Error(
        `storage.${key} is not supported. Configure storage.postgres.*.`,
      );
    }
  }

  const postgresRaw = map.postgres;
  if (
    postgresRaw !== undefined &&
    (typeof postgresRaw !== 'object' ||
      postgresRaw === null ||
      Array.isArray(postgresRaw))
  ) {
    throw new Error('storage.postgres must be a mapping');
  }
  const postgres = (postgresRaw || {}) as Record<string, unknown>;

  return {
    postgres: {
      urlEnv: parseStringValue(
        postgres.url_env,
        'storage.postgres.url_env',
        DEFAULT_STORAGE_POSTGRES_URL_ENV,
      ),
      schema: parsePostgresSchema(postgres.schema, 'storage.postgres.schema'),
    },
  };
}

function parseMemoryLlmModels(
  raw: unknown,
  pathPrefix: string,
): RuntimeMemoryLlmModels {
  const defaults = getMemoryModelProfileDefaults('balanced');
  if (raw === undefined) {
    return defaults;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${pathPrefix} must be a mapping`);
  }
  const map = raw as Record<string, unknown>;
  return {
    extractor: parseStringValue(
      map.extractor,
      `${pathPrefix}.extractor`,
      defaults.extractor,
    ),
    dreaming: parseStringValue(
      map.dreaming,
      `${pathPrefix}.dreaming`,
      defaults.dreaming,
    ),
    consolidation: parseStringValue(
      map.consolidation,
      `${pathPrefix}.consolidation`,
      defaults.consolidation,
    ),
  };
}

function parseMemorySettings(raw: unknown): RuntimeMemorySettings {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('memory must be a mapping');
  }

  const map = raw as Record<string, unknown>;
  const supportedKeys = new Set(['enabled', 'embeddings', 'dreaming', 'llm']);
  for (const key of Object.keys(map)) {
    if (!supportedKeys.has(key)) {
      throw new Error(
        `memory.${key} is not supported. Use memory.enabled/storage.* settings.`,
      );
    }
  }
  const embeddingsRaw = map.embeddings;
  if (
    typeof embeddingsRaw !== 'object' ||
    embeddingsRaw === null ||
    Array.isArray(embeddingsRaw)
  ) {
    throw new Error('memory.embeddings must be a mapping');
  }
  const dreamingRaw = map.dreaming;
  if (
    (dreamingRaw !== undefined && typeof dreamingRaw !== 'object') ||
    dreamingRaw === null ||
    Array.isArray(dreamingRaw)
  ) {
    throw new Error('memory.dreaming must be a mapping');
  }

  const embeddingsMap = embeddingsRaw as Record<string, unknown>;
  const dreamingMap = (dreamingRaw || {}) as Record<string, unknown>;
  const llmRaw = map.llm;
  if (
    llmRaw !== undefined &&
    (typeof llmRaw !== 'object' || llmRaw === null || Array.isArray(llmRaw))
  ) {
    throw new Error('memory.llm must be a mapping');
  }
  const llmMap = (llmRaw || {}) as Record<string, unknown>;
  const enabled = parseBooleanValue(map.enabled, 'memory.enabled');
  const embeddingsEnabled = parseBooleanValue(
    embeddingsMap.enabled,
    'memory.embeddings.enabled',
  );
  const embeddingProvider = parseEmbeddingProvider(
    embeddingsMap.provider,
    'memory.embeddings.provider',
  );

  return {
    enabled,
    embeddings: {
      enabled: embeddingsEnabled,
      provider: embeddingsEnabled ? embeddingProvider : 'disabled',
      model: parseStringValue(
        embeddingsMap.model,
        'memory.embeddings.model',
        DEFAULT_EMBED_MODEL,
      ),
    },
    dreaming: {
      enabled: parseBooleanValue(
        dreamingMap.enabled,
        'memory.dreaming.enabled',
        false,
      ),
    },
    llm: {
      models: parseMemoryLlmModels(llmMap.models, 'memory.llm.models'),
    },
  };
}

export function parseRuntimeSettings(raw: string): RuntimeSettings {
  const parsed = parseSimpleYamlObject(raw) as unknown;

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('root must be a mapping');
  }

  const root = parsed as Record<string, unknown>;
  for (const key of Object.keys(root)) {
    if (key === 'features') {
      throw new Error(
        'features block is not supported. Configure memory settings under memory.*',
      );
    }
    if (key === 'runtime') {
      throw new Error('runtime settings are not supported.');
    }
    if (
      key !== 'version' &&
      key !== 'channels' &&
      key !== 'storage' &&
      key !== 'agent' &&
      key !== 'credential_broker' &&
      key !== 'memory'
    ) {
      throw new Error(
        `${key} is not supported. Supported root keys are version, channels, storage, agent, credential_broker, and memory.`,
      );
    }
  }

  const channels = root.channels;
  if (
    typeof channels !== 'object' ||
    channels === null ||
    Array.isArray(channels)
  ) {
    throw new Error('channels must be a mapping');
  }
  const channelsMap = channels as Record<string, unknown>;

  const channelSettings: Record<string, RuntimeChannelSettings> = {};
  for (const [channelId, channelRaw] of Object.entries(channelsMap)) {
    channelSettings[channelId] = parseChannelSettings(
      channelRaw,
      `channels.${channelId}`,
    );
  }
  for (const provider of listChannelProviders()) {
    if (!channelSettings[provider.id]) {
      channelSettings[provider.id] = createDefaultChannelSettings(false);
    }
  }

  const storage = parseStorageSettings(root.storage);
  const agent = parseAgentSettings(root.agent);
  const credentialBroker = parseCredentialBrokerSettings(
    root.credential_broker,
  );
  const memory = parseMemorySettings(root.memory);

  return {
    channels: channelSettings,
    storage,
    agent,
    credentialBroker,
    memory,
  };
}

export function listEnabledRuntimeChannelIds(
  settings: RuntimeSettings,
): string[] {
  return Object.entries(settings.channels)
    .filter(([, channel]) => channel.enabled)
    .map(([channelId]) => channelId);
}

export function getRuntimeChannelProvider(channelId: string) {
  return getChannelProvider(channelId);
}
