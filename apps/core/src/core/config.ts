import path from 'path';

import {
  readRuntimeMemorySettingsSnapshot,
  readRuntimeStorageSettingsSnapshot,
  type RuntimeMemorySettingsSnapshot,
  type RuntimeStorageSettingsSnapshot,
} from '../cli/runtime-settings.js';
import { envConfig, envValue, envValueDynamic } from './config-env.js';
import { getMyclawHome } from './myclaw-home.js';
import { isValidTimezone } from './timezone.js';

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

const MYCLAW_HOME_RAW =
  process.env.MYCLAW_HOME?.trim() || envConfig.MYCLAW_HOME?.trim() || '';
export const MYCLAW_HOME = getMyclawHome(MYCLAW_HOME_RAW);
const RUNTIME_ROOT = MYCLAW_HOME;

export const SCHEDULER_JOBS_JSON_PATH = path.join(
  MYCLAW_HOME,
  'scheduler-jobs.json',
);
export const STORE_DIR = path.resolve(RUNTIME_ROOT, 'store');
export const AGENTS_DIR = path.resolve(RUNTIME_ROOT, 'agents');
export const DATA_DIR = path.resolve(RUNTIME_ROOT, 'data');

let runtimeStorageSettings: RuntimeStorageSettingsSnapshot = {};
let runtimeStorageSettingsError: Error | null = null;
try {
  runtimeStorageSettings = readRuntimeStorageSettingsSnapshot(MYCLAW_HOME);
} catch (err) {
  runtimeStorageSettingsError =
    err instanceof Error ? err : new Error(String(err));
}
if (runtimeStorageSettingsError) {
  throw new Error(
    `Invalid runtime storage settings: ${runtimeStorageSettingsError.message}`,
  );
}
export const STORAGE_PROVIDER = runtimeStorageSettings.provider || 'sqlite';
const sqlitePathSetting =
  runtimeStorageSettings.sqlitePath || path.join('store', 'myclaw.db');
function assertPathWithinRuntimeRoot(targetPath: string): string {
  const relative = path.relative(RUNTIME_ROOT, targetPath);
  if (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  ) {
    return targetPath;
  }
  throw new Error(
    `Invalid runtime storage settings: storage.sqlite.path must resolve under runtime home (${RUNTIME_ROOT})`,
  );
}
const resolvedStorageSqlitePath = path.isAbsolute(sqlitePathSetting)
  ? path.resolve(sqlitePathSetting)
  : path.resolve(RUNTIME_ROOT, sqlitePathSetting);
export const STORAGE_SQLITE_PATH = assertPathWithinRuntimeRoot(
  resolvedStorageSqlitePath,
);
export const STORAGE_POSTGRES_URL_ENV =
  runtimeStorageSettings.postgresUrlEnv || 'MYCLAW_DATABASE_URL';
export const STORAGE_POSTGRES_URL =
  envValueDynamic(STORAGE_POSTGRES_URL_ENV).trim() || null;
export const STORAGE_POSTGRES_SCHEMA =
  runtimeStorageSettings.postgresSchema || 'myclaw';

let runtimeMemorySettings: RuntimeMemorySettingsSnapshot = {};
let runtimeMemorySettingsError: Error | null = null;
try {
  runtimeMemorySettings = readRuntimeMemorySettingsSnapshot(MYCLAW_HOME);
} catch (err) {
  runtimeMemorySettingsError =
    err instanceof Error ? err : new Error(String(err));
}
if (runtimeMemorySettingsError) {
  throw new Error(
    `Invalid runtime memory settings: ${runtimeMemorySettingsError.message}`,
  );
}
const memoryRootSetting = runtimeMemorySettings.root || 'memory';
export const memoryStorageDir = path.isAbsolute(memoryRootSetting)
  ? path.resolve(memoryRootSetting)
  : path.resolve(RUNTIME_ROOT, memoryRootSetting);
export const MEMORY_SQLITE_PATH = path.resolve(
  memoryStorageDir,
  '.cache',
  'memory.db',
);
export const RUNTIME_MEMORY_ENABLED = runtimeMemorySettings.enabled ?? true;
const MEMORY_GLOBAL_KNOWLEDGE_DIR_RAW =
  process.env.MEMORY_GLOBAL_KNOWLEDGE_DIR ||
  envConfig.MEMORY_GLOBAL_KNOWLEDGE_DIR ||
  '';
function resolveOptionalPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  return path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(RUNTIME_ROOT, trimmed);
}

function parseBooleanEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes')
    return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no')
    return false;
  return fallback;
}

function parseSourceTypeBoosts(
  raw: string | undefined,
  fallback: Record<string, number>,
): Record<string, number> {
  if (!raw?.trim()) return { ...fallback };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return { ...fallback };
    const merged: Record<string, number> = { ...fallback };
    for (const [key, value] of Object.entries(parsed)) {
      const boost = Number(value);
      if (!Number.isFinite(boost) || boost <= 0) continue;
      merged[key] = boost;
    }
    return merged;
  } catch {
    return { ...fallback };
  }
}

export const OPENAI_API_KEY = envValue('OPENAI_API_KEY') || null;
export const OPENAI_DAILY_EMBED_LIMIT = Math.max(
  0,
  parseInt(
    process.env.OPENAI_DAILY_EMBED_LIMIT ||
      envConfig.OPENAI_DAILY_EMBED_LIMIT ||
      '500',
    10,
  ),
); // 0 = unlimited
export const MEMORY_EMBED_MODEL =
  runtimeMemorySettings.embeddingModel || 'text-embedding-3-large';
export const MEMORY_EMBED_PROVIDER =
  runtimeMemorySettings.embeddingsEnabled === false
    ? 'disabled'
    : runtimeMemorySettings.embeddingProvider || 'disabled';
export const MEMORY_CHUNK_SIZE = Math.max(
  300,
  parseInt(
    process.env.MEMORY_CHUNK_SIZE || envConfig.MEMORY_CHUNK_SIZE || '1400',
    10,
  ) || 1400,
);
export const MEMORY_CHUNK_OVERLAP = Math.max(
  0,
  parseInt(
    process.env.MEMORY_CHUNK_OVERLAP || envConfig.MEMORY_CHUNK_OVERLAP || '240',
    10,
  ) || 240,
);
export const MEMORY_RETRIEVAL_LIMIT = Math.max(
  1,
  parseInt(
    process.env.MEMORY_RETRIEVAL_LIMIT ||
      envConfig.MEMORY_RETRIEVAL_LIMIT ||
      '8',
    10,
  ) || 8,
);
export const MEMORY_RETRIEVAL_MIN_SCORE = Math.max(
  0,
  Math.min(
    1,
    parseFloat(
      process.env.MEMORY_RETRIEVAL_MIN_SCORE ||
        envConfig.MEMORY_RETRIEVAL_MIN_SCORE ||
        '0.005',
    ) || 0.005,
  ),
);
export const MEMORY_TEMPORAL_DECAY_HALFLIFE_DAYS = Math.max(
  1,
  parseFloat(
    process.env.MEMORY_TEMPORAL_DECAY_HALFLIFE_DAYS ||
      envConfig.MEMORY_TEMPORAL_DECAY_HALFLIFE_DAYS ||
      '45',
  ) || 45,
);
export const MEMORY_MMR_LAMBDA = Math.max(
  0,
  Math.min(
    1,
    parseFloat(
      process.env.MEMORY_MMR_LAMBDA || envConfig.MEMORY_MMR_LAMBDA || '0.7',
    ) || 0.7,
  ),
);
export const MEMORY_RRF_LEXICAL_WEIGHT = Math.max(
  0,
  parseFloat(
    process.env.MEMORY_RRF_LEXICAL_WEIGHT ||
      envConfig.MEMORY_RRF_LEXICAL_WEIGHT ||
      '1.0',
  ) || 1.0,
);
export const MEMORY_RRF_VECTOR_WEIGHT = Math.max(
  0,
  parseFloat(
    process.env.MEMORY_RRF_VECTOR_WEIGHT ||
      envConfig.MEMORY_RRF_VECTOR_WEIGHT ||
      '1.0',
  ) || 1.0,
);
const DEFAULT_MEMORY_SOURCE_TYPE_BOOSTS: Record<string, number> = {
  claude_md: 1.3,
  local_doc: 1.2,
  knowledge_doc: 1.4,
  conversation: 1.0,
};
export const MEMORY_SOURCE_TYPE_BOOSTS = parseSourceTypeBoosts(
  process.env.MEMORY_SOURCE_TYPE_BOOSTS || envConfig.MEMORY_SOURCE_TYPE_BOOSTS,
  DEFAULT_MEMORY_SOURCE_TYPE_BOOSTS,
);
export const MEMORY_EXTRACTOR_MAX_FACTS = Math.max(
  1,
  parseInt(
    process.env.MEMORY_EXTRACTOR_MAX_FACTS ||
      envConfig.MEMORY_EXTRACTOR_MAX_FACTS ||
      '8',
    10,
  ) || 8,
);
export const MEMORY_EXTRACTOR_MIN_CONFIDENCE = Math.max(
  0,
  Math.min(
    1,
    parseFloat(
      process.env.MEMORY_EXTRACTOR_MIN_CONFIDENCE ||
        envConfig.MEMORY_EXTRACTOR_MIN_CONFIDENCE ||
        '0.6',
    ) || 0.6,
  ),
);
export const MEMORY_EXTRACTOR_MAX_TURNS = Math.max(
  10,
  parseInt(
    process.env.MEMORY_EXTRACTOR_MAX_TURNS ||
      envConfig.MEMORY_EXTRACTOR_MAX_TURNS ||
      '60',
    10,
  ) || 60,
);
export const MEMORY_REFLECTION_MIN_CONFIDENCE = Math.max(
  0,
  Math.min(
    1,
    parseFloat(
      process.env.MEMORY_REFLECTION_MIN_CONFIDENCE ||
        envConfig.MEMORY_REFLECTION_MIN_CONFIDENCE ||
        '0.7',
    ) || 0.7,
  ),
);
export const MEMORY_REFLECTION_MAX_FACTS_PER_TURN = Math.max(
  1,
  parseInt(
    process.env.MEMORY_REFLECTION_MAX_FACTS_PER_TURN ||
      envConfig.MEMORY_REFLECTION_MAX_FACTS_PER_TURN ||
      '6',
    10,
  ) || 6,
);
export const MEMORY_SCOPE_POLICY =
  process.env.MEMORY_SCOPE_POLICY || envConfig.MEMORY_SCOPE_POLICY || 'group';
export const MEMORY_RETENTION_PIN_THRESHOLD = Math.max(
  0,
  Math.min(
    1,
    parseFloat(
      process.env.MEMORY_RETENTION_PIN_THRESHOLD ||
        envConfig.MEMORY_RETENTION_PIN_THRESHOLD ||
        '0.92',
    ) || 0.92,
  ),
);
export const MEMORY_ITEM_MAX_PER_GROUP = Math.max(
  100,
  parseInt(
    process.env.MEMORY_ITEM_MAX_PER_GROUP ||
      envConfig.MEMORY_ITEM_MAX_PER_GROUP ||
      '2000',
    10,
  ) || 2000,
);
export const MEMORY_SEMANTIC_DEDUP_ENABLED = parseBooleanEnv(
  process.env.MEMORY_SEMANTIC_DEDUP_ENABLED ||
    envConfig.MEMORY_SEMANTIC_DEDUP_ENABLED,
  true,
);
export const MEMORY_SEMANTIC_DEDUP_THRESHOLD = Math.max(
  0,
  Math.min(
    1,
    parseFloat(
      process.env.MEMORY_SEMANTIC_DEDUP_THRESHOLD ||
        envConfig.MEMORY_SEMANTIC_DEDUP_THRESHOLD ||
        '0.88',
    ) || 0.88,
  ),
);
export const MEMORY_GLOBAL_KNOWLEDGE_DIR = resolveOptionalPath(
  MEMORY_GLOBAL_KNOWLEDGE_DIR_RAW || path.join(memoryStorageDir, 'knowledge'),
);
export const MEMORY_KNOWLEDGE_EMBED_BUDGET_PER_DAY = Math.max(
  0,
  parseInt(
    process.env.MEMORY_KNOWLEDGE_EMBED_BUDGET_PER_DAY ||
      envConfig.MEMORY_KNOWLEDGE_EMBED_BUDGET_PER_DAY ||
      '200',
    10,
  ) || 200,
);
export const MEMORY_MAX_GLOBAL_CHUNKS = Math.max(
  100,
  parseInt(
    process.env.MEMORY_MAX_GLOBAL_CHUNKS ||
      envConfig.MEMORY_MAX_GLOBAL_CHUNKS ||
      '3000',
    10,
  ) || 3000,
);
export const MEMORY_USAGE_FEEDBACK_ENABLED = parseBooleanEnv(
  process.env.MEMORY_USAGE_FEEDBACK_ENABLED ||
    envConfig.MEMORY_USAGE_FEEDBACK_ENABLED,
  true,
);
export const MEMORY_CONFIDENCE_BOOST_ON_USE = Math.max(
  0,
  Math.min(
    1,
    parseFloat(
      process.env.MEMORY_CONFIDENCE_BOOST_ON_USE ||
        envConfig.MEMORY_CONFIDENCE_BOOST_ON_USE ||
        '0.02',
    ) || 0.02,
  ),
);
export const MEMORY_CONFIDENCE_DECAY_ON_UNUSED = Math.max(
  0,
  Math.min(
    1,
    parseFloat(
      process.env.MEMORY_CONFIDENCE_DECAY_ON_UNUSED ||
        envConfig.MEMORY_CONFIDENCE_DECAY_ON_UNUSED ||
        '0.01',
    ) || 0.01,
  ),
);
export const MEMORY_USAGE_DECAY_INTERVAL_TURNS = Math.max(
  1,
  parseInt(
    process.env.MEMORY_USAGE_DECAY_INTERVAL_TURNS ||
      envConfig.MEMORY_USAGE_DECAY_INTERVAL_TURNS ||
      '20',
    10,
  ) || 20,
);
export const MEMORY_CONSOLIDATION_MIN_ITEMS = Math.max(
  2,
  parseInt(
    process.env.MEMORY_CONSOLIDATION_MIN_ITEMS ||
      envConfig.MEMORY_CONSOLIDATION_MIN_ITEMS ||
      '20',
    10,
  ) || 20,
);
export const MEMORY_CONSOLIDATION_CLUSTER_THRESHOLD = Math.max(
  0,
  Math.min(
    1,
    parseFloat(
      process.env.MEMORY_CONSOLIDATION_CLUSTER_THRESHOLD ||
        envConfig.MEMORY_CONSOLIDATION_CLUSTER_THRESHOLD ||
        '0.8',
    ) || 0.8,
  ),
);
export const RUNTIME_MEMORY_DREAMING_ENABLED =
  runtimeMemorySettings.dreamingEnabled ?? false;
export const MEMORY_DREAMING_CRON =
  process.env.MEMORY_DREAMING_CRON ||
  envConfig.MEMORY_DREAMING_CRON ||
  '0 3 * * *';
export const MEMORY_DREAMING_DRY_RUN = parseBooleanEnv(
  process.env.MEMORY_DREAMING_DRY_RUN || envConfig.MEMORY_DREAMING_DRY_RUN,
  true,
);
export const MEMORY_DREAMING_PROMOTION_THRESHOLD = Math.max(
  0,
  Math.min(
    1,
    parseFloat(
      process.env.MEMORY_DREAMING_PROMOTION_THRESHOLD ||
        envConfig.MEMORY_DREAMING_PROMOTION_THRESHOLD ||
        '0.55',
    ) || 0.55,
  ),
);
export const MEMORY_DREAMING_DECAY_THRESHOLD = Math.max(
  0,
  Math.min(
    1,
    parseFloat(
      process.env.MEMORY_DREAMING_DECAY_THRESHOLD ||
        envConfig.MEMORY_DREAMING_DECAY_THRESHOLD ||
        '0.15',
    ) || 0.15,
  ),
);
export const MEMORY_DREAMING_MIN_RECALLS = Math.max(
  1,
  parseInt(
    process.env.MEMORY_DREAMING_MIN_RECALLS ||
      envConfig.MEMORY_DREAMING_MIN_RECALLS ||
      '3',
    10,
  ) || 3,
);
export const MEMORY_DREAMING_MIN_UNIQUE_QUERIES = Math.max(
  1,
  parseInt(
    process.env.MEMORY_DREAMING_MIN_UNIQUE_QUERIES ||
      envConfig.MEMORY_DREAMING_MIN_UNIQUE_QUERIES ||
      '2',
    10,
  ) || 2,
);
export const MEMORY_DREAMING_CONFIDENCE_BOOST = Math.max(
  0,
  Math.min(
    1,
    parseFloat(
      process.env.MEMORY_DREAMING_CONFIDENCE_BOOST ||
        envConfig.MEMORY_DREAMING_CONFIDENCE_BOOST ||
        '0.05',
    ) || 0.05,
  ),
);
export const MEMORY_DREAMING_CONFIDENCE_DECAY = Math.max(
  0,
  Math.min(
    1,
    parseFloat(
      process.env.MEMORY_DREAMING_CONFIDENCE_DECAY ||
        envConfig.MEMORY_DREAMING_CONFIDENCE_DECAY ||
        '0.03',
    ) || 0.03,
  ),
);
export const MEMORY_EMBED_BATCH_SIZE = Math.max(
  1,
  parseInt(
    process.env.MEMORY_EMBED_BATCH_SIZE ||
      envConfig.MEMORY_EMBED_BATCH_SIZE ||
      '16',
    10,
  ) || 16,
);
export const MEMORY_VECTOR_DIMENSIONS = Math.max(
  128,
  parseInt(
    process.env.MEMORY_VECTOR_DIMENSIONS ||
      envConfig.MEMORY_VECTOR_DIMENSIONS ||
      '3072',
    10,
  ) || 3072,
);
export const MEMORY_MAX_CHUNKS_PER_GROUP = Math.max(
  100,
  parseInt(
    process.env.MEMORY_MAX_CHUNKS_PER_GROUP ||
      envConfig.MEMORY_MAX_CHUNKS_PER_GROUP ||
      '6000',
    10,
  ) || 6000,
);
export const MEMORY_CHUNK_RETENTION_DAYS = Math.max(
  7,
  parseInt(
    process.env.MEMORY_CHUNK_RETENTION_DAYS ||
      envConfig.MEMORY_CHUNK_RETENTION_DAYS ||
      '120',
    10,
  ) || 120,
);
export const MEMORY_MAX_EVENTS = Math.max(
  100,
  parseInt(
    process.env.MEMORY_MAX_EVENTS || envConfig.MEMORY_MAX_EVENTS || '20000',
    10,
  ) || 20000,
);
export const MEMORY_MAX_PROCEDURES_PER_GROUP = Math.max(
  20,
  parseInt(
    process.env.MEMORY_MAX_PROCEDURES_PER_GROUP ||
      envConfig.MEMORY_MAX_PROCEDURES_PER_GROUP ||
      '500',
    10,
  ) || 500,
);
export const PERMISSION_APPROVAL_TIMEOUT_MS = Math.max(
  10_000,
  parseInt(
    process.env.PERMISSION_APPROVAL_TIMEOUT_MS ||
      envConfig.PERMISSION_APPROVAL_TIMEOUT_MS ||
      '300000',
    10,
  ) || 300_000,
);
function parseIdAllowlist(raw: string | undefined): Set<string> {
  if (!raw?.trim()) return new Set<string>();
  return new Set(
    raw
      .split(/[,\s]+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}
export const TELEGRAM_PERMISSION_APPROVER_IDS = parseIdAllowlist(
  process.env.TELEGRAM_PERMISSION_APPROVER_IDS ||
    envConfig.TELEGRAM_PERMISSION_APPROVER_IDS,
);
export const SLACK_PERMISSION_APPROVER_IDS = parseIdAllowlist(
  process.env.SLACK_PERMISSION_APPROVER_IDS ||
    envConfig.SLACK_PERMISSION_APPROVER_IDS,
);
export const MEMORY_CONSOLIDATION_MAX_CLUSTERS = Math.max(
  1,
  parseInt(
    process.env.MEMORY_CONSOLIDATION_MAX_CLUSTERS ||
      envConfig.MEMORY_CONSOLIDATION_MAX_CLUSTERS ||
      '10',
    10,
  ) || 10,
);
export const MEMORY_CONSOLIDATION_EMBEDDING_FALLBACK = parseBooleanEnv(
  process.env.MEMORY_CONSOLIDATION_EMBEDDING_FALLBACK ||
    envConfig.MEMORY_CONSOLIDATION_EMBEDDING_FALLBACK,
  true,
);

export const AGENT_TIMEOUT = parseInt(
  process.env.AGENT_TIMEOUT || '1800000',
  10,
);
export const AGENT_MAX_OUTPUT_SIZE = parseInt(
  process.env.AGENT_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const ONECLI_URL = envValue('ONECLI_URL');
function normalizeModelValue(value?: string): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export const ANTHROPIC_MODEL = normalizeModelValue(envValue('ANTHROPIC_MODEL'));
export const ANTHROPIC_API_KEY = envValue('ANTHROPIC_API_KEY');
export const CLAUDE_OAUTH_TOKEN = envValue('CLAUDE_CODE_OAUTH_TOKEN');
export const TELEGRAM_BOT_TOKEN = envValue('TELEGRAM_BOT_TOKEN');
export const SLACK_BOT_TOKEN = envValue('SLACK_BOT_TOKEN');
export const SLACK_APP_TOKEN = envValue('SLACK_APP_TOKEN');
export const MYCLAW_IPC_AUTH_SECRET = envValue('MYCLAW_IPC_AUTH_SECRET');
export const MYCLAW_CREDENTIAL_MODE = envValue('MYCLAW_CREDENTIAL_MODE');
export const REMOTE_CONTROL_AUTO_ACCEPT = parseBooleanEnv(
  envValue('REMOTE_CONTROL_AUTO_ACCEPT'),
  false,
);
export const CHROME_PATH = envValue('CHROME_PATH') || undefined;
export const LOG_LEVEL = envValue('LOG_LEVEL') || 'info';
export const HOST_CREDENTIAL_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'MEMORY_EXTRACTOR_MAX_TURNS',
] as const;
export const ONECLI_ALLOWED_ENV_KEYS = [
  ...HOST_CREDENTIAL_ENV_KEYS,
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_ORG_ID',
  'OPENAI_PROJECT',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
] as const;
export function getHostCredentialEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of HOST_CREDENTIAL_ENV_KEYS) {
    const value = envValue(key);
    if (value) env[key] = value;
  }
  return env;
}
export function getTelegramBotToken(): string {
  return envValue('TELEGRAM_BOT_TOKEN');
}
export function getSlackBotToken(): string {
  return envValue('SLACK_BOT_TOKEN');
}
export function getSlackAppToken(): string {
  return envValue('SLACK_APP_TOKEN');
}
export type ClaudeAuthMode = 'oauth' | 'api_key' | 'none';

export interface ClaudeAuthState {
  oauthToken: string;
  apiKey: string;
  hasOauthToken: boolean;
  hasApiKey: boolean;
  mode: ClaudeAuthMode;
}

function normalizeSecretValue(value: string | undefined | null): string {
  return value?.trim() || '';
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

export function resolveClaudeAuthState(overrides?: {
  oauthToken?: string | undefined | null;
  apiKey?: string | undefined | null;
}): ClaudeAuthState {
  const hasOauthOverride = Boolean(
    overrides && hasOwn(overrides, 'oauthToken'),
  );
  const hasApiKeyOverride = Boolean(overrides && hasOwn(overrides, 'apiKey'));
  const hasProcessOauth = hasOwn(process.env, 'CLAUDE_CODE_OAUTH_TOKEN');
  const hasProcessApiKey = hasOwn(process.env, 'ANTHROPIC_API_KEY');

  const oauthToken = hasOauthOverride
    ? normalizeSecretValue(overrides?.oauthToken)
    : hasProcessOauth
      ? normalizeSecretValue(process.env.CLAUDE_CODE_OAUTH_TOKEN)
      : CLAUDE_OAUTH_TOKEN;
  const apiKey = hasApiKeyOverride
    ? normalizeSecretValue(overrides?.apiKey)
    : hasProcessApiKey
      ? normalizeSecretValue(process.env.ANTHROPIC_API_KEY)
      : ANTHROPIC_API_KEY;
  const hasOauthToken = Boolean(oauthToken);
  const hasApiKey = Boolean(apiKey);
  const mode: ClaudeAuthMode = hasOauthToken
    ? 'oauth'
    : hasApiKey
      ? 'api_key'
      : 'none';
  return { oauthToken, apiKey, hasOauthToken, hasApiKey, mode };
}

export const LLM_ENABLED = resolveClaudeAuthState().mode !== 'none';

const HARD_DEFAULT_MODEL_EXTRACTOR = 'claude-haiku-4-5-20251001';
const HARD_DEFAULT_MODEL_DREAMING = 'claude-sonnet-4-6';
const HARD_DEFAULT_MODEL_CONSOLIDATION = 'claude-sonnet-4-6';

function resolveMemoryLlmModel(
  taskModel: string | undefined,
  hardDefault: string,
): string {
  return normalizeModelValue(taskModel) || ANTHROPIC_MODEL || hardDefault;
}

export const MODEL_EXTRACTOR = resolveMemoryLlmModel(
  runtimeMemorySettings.llmExtractorModel,
  HARD_DEFAULT_MODEL_EXTRACTOR,
);
export const MODEL_DREAMING = resolveMemoryLlmModel(
  runtimeMemorySettings.llmDreamingModel,
  HARD_DEFAULT_MODEL_DREAMING,
);
export const MODEL_CONSOLIDATION = resolveMemoryLlmModel(
  runtimeMemorySettings.llmConsolidationModel,
  HARD_DEFAULT_MODEL_CONSOLIDATION,
);
export const MEMORY_CLEANUP_PURGE_DAYS = Math.max(
  1,
  parseInt(
    process.env.MEMORY_CLEANUP_PURGE_DAYS ||
      envConfig.MEMORY_CLEANUP_PURGE_DAYS ||
      '30',
    10,
  ) || 30,
);
export const MEMORY_JOURNAL_GZIP_DAYS = Math.max(
  1,
  parseInt(
    process.env.MEMORY_JOURNAL_GZIP_DAYS ||
      envConfig.MEMORY_JOURNAL_GZIP_DAYS ||
      '7',
    10,
  ) || 7,
);
export const MEMORY_JOURNAL_DELETE_DAYS = Math.max(
  1,
  parseInt(
    process.env.MEMORY_JOURNAL_DELETE_DAYS ||
      envConfig.MEMORY_JOURNAL_DELETE_DAYS ||
      '90',
    10,
  ) || 90,
);
export function isMemoryJournalDisabled(): boolean {
  return parseBooleanEnv(
    process.env.MYCLAW_MEMORY_JOURNAL_DISABLED ||
      envConfig.MYCLAW_MEMORY_JOURNAL_DISABLED,
    false,
  );
}

export const MEMORY_JOURNAL_DISABLED = isMemoryJournalDisabled();
export const MEMORY_MAINTENANCE_MAX_PENDING = Math.max(
  100,
  parseInt(
    process.env.MEMORY_MAINTENANCE_MAX_PENDING ||
      envConfig.MEMORY_MAINTENANCE_MAX_PENDING ||
      '5000',
    10,
  ) || 5000,
);
export const MEMORY_BRIEF_INCLUDE_LAST_SESSION = parseBooleanEnv(
  process.env.MEMORY_BRIEF_INCLUDE_LAST_SESSION ||
    envConfig.MEMORY_BRIEF_INCLUDE_LAST_SESSION,
  true,
);
export const MEMORY_BRIEF_DIRTY_REFRESH = parseBooleanEnv(
  process.env.MEMORY_BRIEF_DIRTY_REFRESH ||
    envConfig.MEMORY_BRIEF_DIRTY_REFRESH,
  true,
);

export type DefaultModelSource = 'ANTHROPIC_MODEL' | 'unset';
export type EffectiveModelSource =
  | 'group.agentConfig.model'
  | DefaultModelSource;

export function getDefaultModelConfig(): {
  model?: string;
  source: DefaultModelSource;
} {
  if (ANTHROPIC_MODEL) {
    return { model: ANTHROPIC_MODEL, source: 'ANTHROPIC_MODEL' };
  }
  return { source: 'unset' };
}

export function getEffectiveModelConfig(groupModel?: string): {
  model?: string;
  source: EffectiveModelSource;
} {
  const normalizedGroupModel = normalizeModelValue(groupModel);
  if (normalizedGroupModel) {
    return {
      model: normalizedGroupModel,
      source: 'group.agentConfig.model',
    };
  }
  return getDefaultModelConfig();
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
