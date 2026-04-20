import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

import { isValidGroupFolder } from '../platform/group-folder.js';
import { readEnvFile } from './env-file.js';
import {
  envFilePath,
  ensureRuntimeLayout,
  settingsFilePath,
} from './runtime-home.js';

export interface ChatAllowlistEntry {
  allow: '*' | string[];
  mode: 'trigger' | 'drop';
}

export interface SenderAllowlistConfig {
  default: ChatAllowlistEntry;
  agents: Record<string, ChatAllowlistEntry>;
  logDenied: boolean;
}

export type RuntimeChannel = 'telegram' | 'slack';

export interface RuntimeChannelSettings {
  enabled: boolean;
  senderAllowlist: SenderAllowlistConfig;
}

export type EmbeddingProviderName = 'disabled' | 'none' | 'openai';
export type MemoryModelProfile = 'cheap' | 'balanced' | 'quality';
export type MemoryModelTask =
  | 'extractor'
  | 'dreaming'
  | 'consolidation'
  | 'sessionSummary';

export interface RuntimeMemoryLlmModels {
  extractor: string;
  dreaming: string;
  consolidation: string;
  sessionSummary: string;
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

export interface RuntimeSettings {
  channels: {
    telegram: RuntimeChannelSettings;
    slack: RuntimeChannelSettings;
  };
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
  'none',
  'openai',
]);
const DEFAULT_MEMORY_ROOT = 'memory';
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
    sessionSummary: DEFAULT_MODEL_HAIKU,
  },
  balanced: {
    extractor: DEFAULT_MODEL_HAIKU,
    dreaming: DEFAULT_MODEL_SONNET,
    consolidation: DEFAULT_MODEL_SONNET,
    sessionSummary: DEFAULT_MODEL_HAIKU,
  },
  quality: {
    extractor: DEFAULT_MODEL_SONNET,
    dreaming: DEFAULT_MODEL_SONNET,
    consolidation: DEFAULT_MODEL_SONNET,
    sessionSummary: DEFAULT_MODEL_SONNET,
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
    sessionSummary: selected.sessionSummary,
  };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseStringArray(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed === '[]') return [];

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (
      Array.isArray(parsed) &&
      parsed.every((item) => typeof item === 'string' && item.trim())
    ) {
      return parsed.map((item) => item.trim());
    }
  } catch {
    // Fallback parser below.
  }

  const body = trimmed.slice(1, -1).trim();
  if (!body) return [];
  return body
    .split(',')
    .map((item) => unquote(item))
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function stripInlineComment(raw: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === '#' && !inSingle && !inDouble) {
      return raw.slice(0, i).trimEnd();
    }
  }
  return raw.trimEnd();
}

function parseScalar(raw: string): unknown {
  const value = stripInlineComment(raw).trim();
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === '{}') return {};
  if (/^-?[0-9]+$/.test(value)) return Number.parseInt(value, 10);
  if (value.startsWith('[') && value.endsWith(']')) {
    return parseStringArray(value);
  }
  return unquote(value);
}

function splitKeyValue(
  trimmedLine: string,
  lineNo: number,
): { key: string; rest: string } {
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < trimmedLine.length; i += 1) {
    const ch = trimmedLine[i];
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === ':' && !inSingle && !inDouble) {
      const keyRaw = trimmedLine.slice(0, i).trim();
      const rest = trimmedLine.slice(i + 1).trim();
      if (!keyRaw) {
        throw new Error(`missing key before ':' (line ${lineNo + 1})`);
      }
      return { key: unquote(keyRaw), rest };
    }
  }

  throw new Error(`expected "key: value" mapping (line ${lineNo + 1})`);
}

function parseSimpleYamlObject(raw: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; value: Record<string, unknown> }> = [
    { indent: -1, value: root },
  ];

  const lines = raw.split(/\r?\n/);
  for (let lineNo = 0; lineNo < lines.length; lineNo += 1) {
    const line = lines[lineNo];
    if (!line.trim()) continue;
    if (line.trimStart().startsWith('#')) continue;
    if (line.includes('\t')) {
      throw new Error(`tabs are not supported (line ${lineNo + 1})`);
    }

    const indent = line.match(/^ */)?.[0].length || 0;
    if (indent % 2 !== 0) {
      throw new Error(
        `indentation must be 2-space aligned (line ${lineNo + 1})`,
      );
    }

    const trimmed = line.trim();
    const { key, rest } = splitKeyValue(trimmed, lineNo);

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1]?.value;
    if (!parent) {
      throw new Error(`invalid indentation nesting (line ${lineNo + 1})`);
    }

    if (!rest) {
      const child: Record<string, unknown> = {};
      parent[key] = child;
      stack.push({ indent, value: child });
      continue;
    }

    parent[key] = parseScalar(rest);
  }

  return root;
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
    throw new Error(`${pathPrefix} must be disabled, none, or openai`);
  }
  return raw as EmbeddingProviderName;
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
    sessionSummary: parseStringValue(
      map.session_summary ?? map.sessionSummary,
      `${pathPrefix}.session_summary`,
      defaults.sessionSummary,
    ),
  };
}

function parseMemorySettings(raw: unknown): RuntimeMemorySettings {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('memory must be a mapping');
  }

  const map = raw as Record<string, unknown>;
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

function parseRuntimeSettings(raw: string): RuntimeSettings {
  const parsed = raw.trimStart().startsWith('{')
    ? (JSON.parse(raw) as unknown)
    : (parseSimpleYamlObject(raw) as unknown);

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

  const telegram = parseChannelSettings(
    channelsMap.telegram,
    'channels.telegram',
  );
  const slack = parseChannelSettings(channelsMap.slack, 'channels.slack');

  if (root.features !== undefined) {
    throw new Error(
      'features block is not supported. Configure memory settings under memory.*',
    );
  }
  const memory = parseMemorySettings(root.memory);

  return {
    channels: { telegram, slack },
    memory,
  };
}

interface RegisteredGroupSummary {
  count: number;
  folders: Set<string>;
  error?: string;
}

function getRegisteredGroupSummary(
  runtimeHome: string,
  prefix: 'tg:%' | 'sl:%',
): RegisteredGroupSummary {
  const dbPath = path.join(runtimeHome, 'store', 'messages.db');
  if (!fs.existsSync(dbPath)) {
    return { count: 0, folders: new Set() };
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const rows = db
      .prepare('SELECT jid, folder FROM registered_groups WHERE jid LIKE ?')
      .all(prefix) as Array<{ jid: string; folder: string }>;
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

function quoteYamlString(value: string): string {
  if (/^[A-Za-z0-9_./-]+$/.test(value)) return value;
  return JSON.stringify(value);
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
    `      session_summary: ${quoteYamlString(memory.llm.models.sessionSummary)}`,
    '',
  );
}

function renderRuntimeSettingsYaml(settings: RuntimeSettings): string {
  const lines = [
    'channels:',
    '  telegram:',
    `    enabled: ${settings.channels.telegram.enabled ? 'true' : 'false'}`,
    '    sender_allowlist:',
  ];

  renderSenderAllowlistYaml(
    lines,
    '      ',
    settings.channels.telegram.senderAllowlist,
  );

  lines.push(
    '  slack:',
    `    enabled: ${settings.channels.slack.enabled ? 'true' : 'false'}`,
    '    sender_allowlist:',
  );

  renderSenderAllowlistYaml(
    lines,
    '      ',
    settings.channels.slack.senderAllowlist,
  );

  lines.push('');
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

function createDefaultRuntimeSettings(): RuntimeSettings {
  const memory: RuntimeMemorySettings = {
    enabled: true,
    root: DEFAULT_MEMORY_ROOT,
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
    channels: {
      telegram: createDefaultChannelSettings(false),
      slack: createDefaultChannelSettings(false),
    },
    memory,
  };
}

export function createDefaultRuntimeSettingsForTest(): RuntimeSettings {
  return createDefaultRuntimeSettings();
}

export function applyMemoryModelProfile(
  settings: RuntimeSettings,
  profile: MemoryModelProfile,
): void {
  settings.memory.llm.models = getMemoryModelProfileDefaults(profile);
}

export function parseRuntimeSettingsText(raw: string): RuntimeSettings {
  return parseRuntimeSettings(raw);
}

export function loadRuntimeSettingsFromPath(filePath: string): RuntimeSettings {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return parseRuntimeSettings(raw);
}

function shouldCanonicalizeSettings(raw: string): boolean {
  return raw.trimStart().startsWith('{');
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
  if (shouldCanonicalizeSettings(raw)) {
    saveRuntimeSettings(runtimeHome, settings);
  }
  return { settings, filePath };
}

export function ensureRuntimeSettings(runtimeHome: string): RuntimeSettings {
  return ensureRuntimeSettingsLoaded(runtimeHome).settings;
}

export function loadRuntimeSettings(runtimeHome: string): RuntimeSettings {
  return ensureRuntimeSettingsLoaded(runtimeHome).settings;
}

export function validateRuntimeSettings(
  runtimeHome: string,
): RuntimeSettingsValidationResult {
  try {
    const { settings } = ensureRuntimeSettingsLoaded(runtimeHome);
    const details: string[] = [];

    const env = readEnvFile(envFilePath(runtimeHome));
    const telegramEnabled = settings.channels.telegram.enabled;
    const slackEnabled = settings.channels.slack.enabled;
    if (!telegramEnabled && !slackEnabled) {
      details.push(
        'Enable at least one channel in settings.yaml (channels.telegram.enabled or channels.slack.enabled).',
      );
    }

    if (telegramEnabled && !env.TELEGRAM_BOT_TOKEN?.trim()) {
      details.push('TELEGRAM_BOT_TOKEN is required when Telegram is enabled.');
    }

    if (slackEnabled) {
      if (!env.SLACK_BOT_TOKEN?.trim()) {
        details.push('SLACK_BOT_TOKEN is required when Slack is enabled.');
      }
      if (!env.SLACK_APP_TOKEN?.trim()) {
        details.push('SLACK_APP_TOKEN is required when Slack is enabled.');
      }
    }

    const telegram = getRegisteredGroupSummary(runtimeHome, 'tg:%');
    if (telegram.error) {
      details.push(
        `Could not validate Telegram registered groups: ${telegram.error}`,
      );
    } else if (telegramEnabled && telegram.count === 0) {
      details.push(
        'Telegram channel is enabled but no Telegram chats are registered.',
      );
    } else {
      for (const folder of Object.keys(
        settings.channels.telegram.senderAllowlist.agents,
      )) {
        if (!telegram.folders.has(folder)) {
          details.push(
            `channels.telegram.sender_allowlist.agents.${folder} is not a registered Telegram agent folder.`,
          );
        }
      }
    }

    const slack = getRegisteredGroupSummary(runtimeHome, 'sl:%');
    if (slack.error) {
      details.push(
        `Could not validate Slack registered groups: ${slack.error}`,
      );
    } else if (slackEnabled && slack.count === 0) {
      details.push(
        'Slack channel is enabled but no Slack chats are registered.',
      );
    } else {
      for (const folder of Object.keys(
        settings.channels.slack.senderAllowlist.agents,
      )) {
        if (!slack.folders.has(folder)) {
          details.push(
            `channels.slack.sender_allowlist.agents.${folder} is not a registered Slack agent folder.`,
          );
        }
      }
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
