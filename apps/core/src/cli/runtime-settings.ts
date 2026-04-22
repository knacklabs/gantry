import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { like } from 'drizzle-orm';
import { drizzle as drizzleSqlite } from 'drizzle-orm/better-sqlite3';
import '../channels/register-builtins.js';

import { isValidGroupFolder } from '../platform/group-folder-rules.js';
import * as sqliteSchema from '../storage/schema/sqlite.js';
import {
  getChannelProvider,
  listChannelProviders,
} from '../channels/provider-registry.js';
import { readEnvFile } from './env-file.js';
import {
  envFilePath,
  ensureRuntimeLayout,
  settingsFilePath,
} from './runtime-home.js';
import {
  parseRuntimeMemorySnapshotFromRoot,
  parseRuntimeStorageSnapshotFromRoot,
  type RuntimeMemorySettingsSnapshot,
  type RuntimeStorageSettingsSnapshot,
} from './runtime-memory-settings-snapshot.js';
import {
  parseSimpleYamlObject,
  quoteYamlString,
} from './runtime-settings-yaml.js';

export interface ChatAllowlistEntry {
  allow: '*' | string[];
  mode: 'trigger' | 'drop';
}

export interface SenderAllowlistConfig {
  default: ChatAllowlistEntry;
  agents: Record<string, ChatAllowlistEntry>;
  logDenied: boolean;
}

export type RuntimeChannel = string;

export interface RuntimeChannelSettings {
  enabled: boolean;
  senderAllowlist: SenderAllowlistConfig;
}

export type StorageProviderName = 'sqlite' | 'postgres';
export type EmbeddingProviderName = 'disabled' | 'openai';
export type MemoryModelProfile = 'cheap' | 'balanced' | 'quality';
export type MemoryModelTask = 'extractor' | 'dreaming' | 'consolidation';

export interface RuntimeMemoryLlmModels {
  extractor: string;
  dreaming: string;
  consolidation: string;
}

export interface RuntimeMemorySettings {
  enabled: boolean;
  root: string;
  embeddings: {
    enabled: boolean;
    provider: EmbeddingProviderName;
    model: string;
  };
  dreaming: {
    enabled: boolean;
  };
  llm: {
    models: RuntimeMemoryLlmModels;
  };
}

export interface RuntimeStorageSettings {
  provider: StorageProviderName;
  sqlite: {
    path: string;
  };
  postgres: {
    urlEnv: string;
    schema: string;
  };
}

export type { RuntimeMemorySettingsSnapshot, RuntimeStorageSettingsSnapshot };

export interface RuntimeSettings {
  channels: Record<string, RuntimeChannelSettings>;
  storage: RuntimeStorageSettings;
  memory: RuntimeMemorySettings;
}

export interface RuntimeSettingsValidationFailure {
  summary: string;
  details: string[];
}

export interface RuntimeSettingsValidationResult {
  ok: boolean;
  settings?: RuntimeSettings;
  failure?: RuntimeSettingsValidationFailure;
}

const DEFAULT_SENDER_ALLOWLIST: SenderAllowlistConfig = {
  default: { allow: '*', mode: 'trigger' },
  agents: {},
  logDenied: true,
};

const VALID_EMBEDDING_PROVIDERS = new Set<EmbeddingProviderName>([
  'disabled',
  'openai',
]);
const VALID_STORAGE_PROVIDERS = new Set<StorageProviderName>([
  'sqlite',
  'postgres',
]);
const DEFAULT_STORAGE_PROVIDER: StorageProviderName = 'sqlite';
const DEFAULT_STORAGE_SQLITE_PATH = path.join('store', 'myclaw.db');
const DEFAULT_STORAGE_POSTGRES_URL_ENV = 'MYCLAW_DATABASE_URL';
const DEFAULT_STORAGE_POSTGRES_SCHEMA = 'myclaw';
const DEFAULT_MEMORY_STORAGE_DIR = 'memory';
const DEFAULT_EMBED_MODEL = 'text-embedding-3-large';
const DEFAULT_MODEL_HAIKU = 'claude-haiku-4-5-20251001';
const DEFAULT_MODEL_SONNET = 'claude-sonnet-4-6';

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

function isValidAllowlistEntry(entry: unknown): entry is ChatAllowlistEntry {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const row = entry as Record<string, unknown>;
  const allow = row.allow;
  const mode = row.mode;
  const validAllow =
    allow === '*' ||
    (Array.isArray(allow) &&
      allow.every((item) => typeof item === 'string' && item.trim()));
  const validMode = mode === 'trigger' || mode === 'drop';
  return validAllow && validMode;
}

function normalizeAllowlistEntry(
  entry: ChatAllowlistEntry,
): ChatAllowlistEntry {
  return {
    allow: entry.allow === '*' ? '*' : entry.allow.map((value) => value.trim()),
    mode: entry.mode,
  };
}

function parseSenderAllowlistConfig(
  raw: unknown,
  pathPrefix: string,
): SenderAllowlistConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${pathPrefix} must be a mapping`);
  }

  const map = raw as Record<string, unknown>;

  if (!isValidAllowlistEntry(map.default)) {
    throw new Error(`${pathPrefix}.default must include allow and mode`);
  }

  const agentsRaw = map.agents;
  if (
    typeof agentsRaw !== 'object' ||
    agentsRaw === null ||
    Array.isArray(agentsRaw)
  ) {
    throw new Error(`${pathPrefix}.agents must be a mapping`);
  }

  const agentsMap = agentsRaw as Record<string, unknown>;
  const agents: Record<string, ChatAllowlistEntry> = {};
  for (const [folder, entry] of Object.entries(agentsMap)) {
    const trimmedFolder = folder.trim();
    if (!trimmedFolder) {
      throw new Error(`${pathPrefix}.agents has empty key`);
    }
    if (!isValidGroupFolder(trimmedFolder)) {
      throw new Error(
        `${pathPrefix}.agents.${trimmedFolder} must use a valid agent folder key`,
      );
    }
    if (!isValidAllowlistEntry(entry)) {
      throw new Error(`${pathPrefix}.agents.${trimmedFolder} is invalid`);
    }
    agents[trimmedFolder] = normalizeAllowlistEntry(entry);
  }

  if (typeof map.log_denied !== 'boolean') {
    throw new Error(`${pathPrefix}.log_denied must be true/false`);
  }

  return {
    default: normalizeAllowlistEntry(map.default as ChatAllowlistEntry),
    agents,
    logDenied: map.log_denied,
  };
}

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

function parseEmbeddingProvider(
  raw: unknown,
  pathPrefix: string,
): EmbeddingProviderName {
  if (
    typeof raw !== 'string' ||
    !VALID_EMBEDDING_PROVIDERS.has(raw as EmbeddingProviderName)
  ) {
    throw new Error(`${pathPrefix} must be disabled or openai`);
  }
  return raw as EmbeddingProviderName;
}

function parseStorageProvider(
  raw: unknown,
  pathPrefix: string,
  fallback: StorageProviderName,
): StorageProviderName {
  if (raw === undefined) return fallback;
  if (
    typeof raw !== 'string' ||
    !VALID_STORAGE_PROVIDERS.has(raw as StorageProviderName)
  ) {
    throw new Error(`${pathPrefix} must be sqlite or postgres`);
  }
  return raw as StorageProviderName;
}

function parsePostgresSchema(raw: unknown, pathPrefix: string): string {
  const value = parseStringValue(
    raw,
    pathPrefix,
    DEFAULT_STORAGE_POSTGRES_SCHEMA,
  );
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(value)) {
    throw new Error(
      `${pathPrefix} must be a valid PostgreSQL schema identifier`,
    );
  }
  return value;
}

function parseStorageSettings(raw: unknown): RuntimeStorageSettings {
  if (raw === undefined) {
    return {
      provider: DEFAULT_STORAGE_PROVIDER,
      sqlite: { path: DEFAULT_STORAGE_SQLITE_PATH },
      postgres: {
        urlEnv: DEFAULT_STORAGE_POSTGRES_URL_ENV,
        schema: DEFAULT_STORAGE_POSTGRES_SCHEMA,
      },
    };
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('storage must be a mapping');
  }
  const map = raw as Record<string, unknown>;
  const sqliteRaw = map.sqlite;
  if (
    sqliteRaw !== undefined &&
    (typeof sqliteRaw !== 'object' ||
      sqliteRaw === null ||
      Array.isArray(sqliteRaw))
  ) {
    throw new Error('storage.sqlite must be a mapping');
  }
  const sqlite = (sqliteRaw || {}) as Record<string, unknown>;
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
    provider: parseStorageProvider(
      map.provider,
      'storage.provider',
      DEFAULT_STORAGE_PROVIDER,
    ),
    sqlite: {
      path: parseStringValue(
        sqlite.path,
        'storage.sqlite.path',
        DEFAULT_STORAGE_SQLITE_PATH,
      ),
    },
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
  for (const deprecated of ['provider', 'sqlite_path', 'qmd_root']) {
    if (Object.prototype.hasOwnProperty.call(map, deprecated)) {
      throw new Error(
        `memory.${deprecated} is not supported. Use memory.enabled/storage.* settings.`,
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
  if (!Object.prototype.hasOwnProperty.call(map, 'root')) {
    throw new Error('memory.root must be set explicitly');
  }
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
    root: parseStringValue(map.root, 'memory.root'),
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

  if (root.features !== undefined) {
    throw new Error(
      'features block is not supported. Configure memory settings under memory.*',
    );
  }
  const storage = parseStorageSettings(root.storage);
  const memory = parseMemorySettings(root.memory);

  return {
    channels: channelSettings,
    storage,
    memory,
  };
}

interface RegisteredGroupSummary {
  count: number;
  folders: Set<string>;
  error?: string;
  unavailable?: boolean;
}

function isPathWithinRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

export function resolveRuntimeStorageSqlitePath(
  runtimeHome: string,
  settings: RuntimeSettings,
): string {
  const rawPath = settings.storage.sqlite.path.trim();
  const resolved = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(runtimeHome, rawPath);
  if (!isPathWithinRoot(runtimeHome, resolved)) {
    throw new Error(
      `storage.sqlite.path must resolve under runtime home (${runtimeHome})`,
    );
  }
  return resolved;
}

function getRegisteredGroupSummary(
  runtimeHome: string,
  settings: RuntimeSettings,
  prefix: string,
): RegisteredGroupSummary {
  const dbPath = resolveRuntimeStorageSqlitePath(runtimeHome, settings);
  if (!fs.existsSync(dbPath)) {
    return { count: 0, folders: new Set() };
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const drizzleDb = drizzleSqlite(db, { schema: sqliteSchema });
    const rows = drizzleDb
      .select({
        jid: sqliteSchema.registeredGroupsSqlite.jid,
        folder: sqliteSchema.registeredGroupsSqlite.folder,
      })
      .from(sqliteSchema.registeredGroupsSqlite)
      .where(like(sqliteSchema.registeredGroupsSqlite.jid, prefix))
      .all();
    return {
      count: rows.length,
      folders: new Set(
        rows
          .map((row) => row.folder)
          .filter((folder) => typeof folder === 'string' && folder.trim())
          .map((folder) => folder.trim()),
      ),
    };
  } catch (err) {
    return {
      count: 0,
      folders: new Set(),
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    try {
      db?.close();
    } catch {
      // Keep primary error only.
    }
  }
}

function quoteYamlKey(key: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(key)) return key;
  return JSON.stringify(key);
}

function renderAllowValue(allow: '*' | string[]): string {
  if (allow === '*') return '"*"';
  return JSON.stringify(allow);
}

function renderSenderAllowlistYaml(
  lines: string[],
  indent: string,
  config: SenderAllowlistConfig,
): void {
  lines.push(`${indent}default:`);
  lines.push(`${indent}  allow: ${renderAllowValue(config.default.allow)}`);
  lines.push(`${indent}  mode: ${config.default.mode}`);
  lines.push(`${indent}agents:`);

  const entries = Object.entries(config.agents).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  for (const [folder, entry] of entries) {
    lines.push(`${indent}  ${quoteYamlKey(folder)}:`);
    lines.push(`${indent}    allow: ${renderAllowValue(entry.allow)}`);
    lines.push(`${indent}    mode: ${entry.mode}`);
  }

  lines.push(`${indent}log_denied: ${config.logDenied ? 'true' : 'false'}`);
}

function renderMemorySettingsYaml(
  lines: string[],
  memory: RuntimeMemorySettings,
): void {
  lines.push(
    'memory:',
    `  enabled: ${memory.enabled ? 'true' : 'false'}`,
    `  root: ${quoteYamlString(memory.root)}`,
    '  embeddings:',
    `    enabled: ${memory.embeddings.enabled ? 'true' : 'false'}`,
    `    provider: ${memory.embeddings.provider}`,
    `    model: ${quoteYamlString(memory.embeddings.model)}`,
    '  dreaming:',
    `    enabled: ${memory.dreaming.enabled ? 'true' : 'false'}`,
    '  llm:',
    '    models:',
    `      extractor: ${quoteYamlString(memory.llm.models.extractor)}`,
    `      dreaming: ${quoteYamlString(memory.llm.models.dreaming)}`,
    `      consolidation: ${quoteYamlString(memory.llm.models.consolidation)}`,
    '',
  );
}

function renderStorageSettingsYaml(
  lines: string[],
  storage: RuntimeStorageSettings,
): void {
  lines.push(
    'storage:',
    `  provider: ${storage.provider}`,
    '  sqlite:',
    `    path: ${quoteYamlString(storage.sqlite.path)}`,
    '  postgres:',
    `    url_env: ${quoteYamlString(storage.postgres.urlEnv)}`,
    `    schema: ${quoteYamlString(storage.postgres.schema)}`,
    '',
  );
}

function renderRuntimeSettingsYaml(settings: RuntimeSettings): string {
  const lines = ['channels:'];
  const providerIds = listChannelProviders().map((provider) => provider.id);
  const extraIds = Object.keys(settings.channels)
    .filter((id) => !providerIds.includes(id))
    .sort((a, b) => a.localeCompare(b));

  for (const channelId of [...providerIds, ...extraIds]) {
    const channelSettings =
      settings.channels[channelId] || createDefaultChannelSettings(false);
    lines.push(
      `  ${quoteYamlKey(channelId)}:`,
      `    enabled: ${channelSettings.enabled ? 'true' : 'false'}`,
      '    sender_allowlist:',
    );
    renderSenderAllowlistYaml(lines, '      ', channelSettings.senderAllowlist);
  }

  lines.push('');
  renderStorageSettingsYaml(lines, settings.storage);
  renderMemorySettingsYaml(lines, settings.memory);

  return lines.join('\n');
}

export function saveRuntimeSettings(
  runtimeHome: string,
  settings: RuntimeSettings,
): void {
  fs.writeFileSync(
    settingsFilePath(runtimeHome),
    renderRuntimeSettingsYaml(settings),
    'utf-8',
  );
}

function createDefaultChannelSettings(
  enabled: boolean,
): RuntimeChannelSettings {
  return {
    enabled,
    senderAllowlist: {
      default: { ...DEFAULT_SENDER_ALLOWLIST.default },
      agents: {},
      logDenied: DEFAULT_SENDER_ALLOWLIST.logDenied,
    },
  };
}

export function createDefaultRuntimeSettings(): RuntimeSettings {
  const storage: RuntimeStorageSettings = {
    provider: DEFAULT_STORAGE_PROVIDER,
    sqlite: {
      path: DEFAULT_STORAGE_SQLITE_PATH,
    },
    postgres: {
      urlEnv: DEFAULT_STORAGE_POSTGRES_URL_ENV,
      schema: DEFAULT_STORAGE_POSTGRES_SCHEMA,
    },
  };
  const memory: RuntimeMemorySettings = {
    enabled: true,
    root: DEFAULT_MEMORY_STORAGE_DIR,
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
    memory,
  };
}

export function applyMemoryModelProfile(
  settings: RuntimeSettings,
  profile: MemoryModelProfile,
): void {
  settings.memory.llm.models = getMemoryModelProfileDefaults(profile);
}

export function loadRuntimeSettingsFromPath(filePath: string): RuntimeSettings {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return parseRuntimeSettings(raw);
}

function ensureRuntimeSettingsLoaded(runtimeHome: string): {
  settings: RuntimeSettings;
  filePath: string;
} {
  ensureRuntimeLayout(runtimeHome);
  const filePath = settingsFilePath(runtimeHome);
  if (!fs.existsSync(filePath)) {
    const defaults = createDefaultRuntimeSettings();
    saveRuntimeSettings(runtimeHome, defaults);
    return { settings: defaults, filePath };
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const settings = parseRuntimeSettings(raw);
  return { settings, filePath };
}

export function ensureRuntimeSettings(runtimeHome: string): RuntimeSettings {
  return ensureRuntimeSettingsLoaded(runtimeHome).settings;
}

export function loadRuntimeSettings(runtimeHome: string): RuntimeSettings {
  return ensureRuntimeSettingsLoaded(runtimeHome).settings;
}

export function readRuntimeMemorySettingsSnapshot(
  runtimeHome: string,
): RuntimeMemorySettingsSnapshot {
  const filePath = settingsFilePath(runtimeHome);
  if (!fs.existsSync(filePath)) return {};

  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = raw.trimStart().startsWith('{')
    ? (JSON.parse(raw) as unknown)
    : (parseSimpleYamlObject(raw) as unknown);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('root must be a mapping');
  }
  return parseRuntimeMemorySnapshotFromRoot(parsed as Record<string, unknown>);
}

export function readRuntimeStorageSettingsSnapshot(
  runtimeHome: string,
): RuntimeStorageSettingsSnapshot {
  const filePath = settingsFilePath(runtimeHome);
  if (!fs.existsSync(filePath)) return {};

  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = raw.trimStart().startsWith('{')
    ? (JSON.parse(raw) as unknown)
    : (parseSimpleYamlObject(raw) as unknown);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('root must be a mapping');
  }
  return parseRuntimeStorageSnapshotFromRoot(parsed as Record<string, unknown>);
}

export function validateRuntimeSettings(
  runtimeHome: string,
): RuntimeSettingsValidationResult {
  try {
    const { settings } = ensureRuntimeSettingsLoaded(runtimeHome);
    const details: string[] = [];

    try {
      resolveRuntimeStorageSqlitePath(runtimeHome, settings);
    } catch (err) {
      details.push(err instanceof Error ? err.message : String(err));
    }

    const env = readEnvFile(envFilePath(runtimeHome));
    const enabledChannelIds = Object.entries(settings.channels)
      .filter(([, channel]) => channel.enabled)
      .map(([channelId]) => channelId);

    for (const channelId of enabledChannelIds) {
      const provider = getChannelProvider(channelId);
      if (!provider) {
        details.push(
          `channels.${channelId}.enabled is true but no provider is registered for '${channelId}'.`,
        );
        continue;
      }

      for (const envKey of provider.setup.envKeys) {
        if (!env[envKey]?.trim()) {
          details.push(
            `${envKey} is required when channel '${provider.id}' is enabled.`,
          );
        }
      }

      const summary = getRegisteredGroupSummary(
        runtimeHome,
        settings,
        `${provider.jidPrefix}%`,
      );
      if (summary.unavailable) {
        continue;
      }
      if (summary.error) {
        details.push(
          `Could not validate registered groups for '${provider.id}': ${summary.error}`,
        );
        continue;
      }

      if (summary.count === 0) {
        details.push(
          `Channel '${provider.id}' is enabled but no chats are registered for prefix '${provider.jidPrefix}'.`,
        );
      }

      const channelSettings = settings.channels[provider.id];
      for (const folder of Object.keys(
        channelSettings.senderAllowlist.agents,
      )) {
        if (!summary.folders.has(folder)) {
          details.push(
            `channels.${provider.id}.sender_allowlist.agents.${folder} is not a registered ${provider.label} agent folder.`,
          );
        }
      }
    }

    if (settings.storage.provider === 'postgres') {
      details.push(
        'storage.provider=postgres is not available in host runtime yet. Use storage.provider=sqlite.',
      );
    }

    if (
      settings.memory.embeddings.enabled &&
      settings.memory.embeddings.provider === 'disabled'
    ) {
      details.push(
        'memory.embeddings.provider cannot be disabled when memory.embeddings.enabled is true.',
      );
    }
    if (settings.memory.dreaming.enabled && !settings.memory.enabled) {
      details.push('memory.dreaming.enabled requires memory.enabled=true.');
    }

    if (details.length > 0) {
      return {
        ok: false,
        settings,
        failure: {
          summary: 'settings file is invalid for the current runtime',
          details,
        },
      };
    }

    return { ok: true, settings };
  } catch (err) {
    return {
      ok: false,
      failure: {
        summary: 'settings file is invalid',
        details: [
          `File: ${settingsFilePath(runtimeHome)}`,
          err instanceof Error ? err.message : String(err),
        ],
      },
    };
  }
}
