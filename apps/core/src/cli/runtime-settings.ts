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

export interface RuntimeSettings {
  version: 3;
  channels: {
    telegram: RuntimeChannelSettings;
    slack: RuntimeChannelSettings;
  };
  features: {
    memory: boolean;
    embeddings: boolean;
    dreaming: boolean;
  };
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

function parseBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no') {
    return false;
  }
  return fallback;
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

function parseScalar(raw: string): unknown {
  const value = raw.trim();
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

function parseRuntimeSettings(raw: string): RuntimeSettings {
  const parsed = raw.trimStart().startsWith('{')
    ? (JSON.parse(raw) as unknown)
    : (parseSimpleYamlObject(raw) as unknown);

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('root must be a mapping');
  }

  const root = parsed as Record<string, unknown>;
  if (root.version !== 3) {
    throw new Error('version must be set to 3');
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

  const telegram = parseChannelSettings(
    channelsMap.telegram,
    'channels.telegram',
  );
  const slack = parseChannelSettings(channelsMap.slack, 'channels.slack');

  const features = root.features;
  if (
    typeof features !== 'object' ||
    features === null ||
    Array.isArray(features)
  ) {
    throw new Error('features must be a mapping');
  }

  const featuresMap = features as Record<string, unknown>;
  const memory = featuresMap.memory;
  const embeddings = featuresMap.embeddings;
  const dreaming = featuresMap.dreaming;
  if (typeof memory !== 'boolean') {
    throw new Error('features.memory must be true/false');
  }
  if (typeof embeddings !== 'boolean') {
    throw new Error('features.embeddings must be true/false');
  }
  if (typeof dreaming !== 'boolean') {
    throw new Error('features.dreaming must be true/false');
  }

  return {
    version: 3,
    channels: { telegram, slack },
    features: {
      memory,
      embeddings,
      dreaming,
    },
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

function renderRuntimeSettingsYaml(settings: RuntimeSettings): string {
  const lines = [
    'version: 3',
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

  lines.push(
    'features:',
    `  memory: ${settings.features.memory ? 'true' : 'false'}`,
    `  embeddings: ${settings.features.embeddings ? 'true' : 'false'}`,
    `  dreaming: ${settings.features.dreaming ? 'true' : 'false'}`,
    '',
  );

  return lines.join('\n');
}

function writeRuntimeSettings(
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

export function deriveRuntimeSettingsFromEnv(
  runtimeHome: string,
): RuntimeSettings {
  const env = readEnvFile(envFilePath(runtimeHome));
  const memoryEnabled = (env.MEMORY_PROVIDER || 'sqlite') !== 'noop';
  const embeddingsEnabled =
    memoryEnabled && (env.MEMORY_EMBED_PROVIDER || 'disabled') === 'openai';
  const dreamingEnabled = parseBoolean(env.MEMORY_DREAMING_ENABLED, false);

  return {
    version: 3,
    channels: {
      telegram: createDefaultChannelSettings(
        Boolean(env.TELEGRAM_BOT_TOKEN?.trim()),
      ),
      slack: createDefaultChannelSettings(
        Boolean(env.SLACK_BOT_TOKEN?.trim() && env.SLACK_APP_TOKEN?.trim()),
      ),
    },
    features: {
      memory: memoryEnabled,
      embeddings: embeddingsEnabled,
      dreaming: dreamingEnabled,
    },
  };
}

export function parseRuntimeSettingsText(raw: string): RuntimeSettings {
  return parseRuntimeSettings(raw);
}

export function loadRuntimeSettingsFromPath(filePath: string): RuntimeSettings {
  const raw = fs.readFileSync(filePath, 'utf-8');
  return parseRuntimeSettings(raw);
}

function ensureSettingsLoaded(runtimeHome: string): {
  settings: RuntimeSettings;
  filePath: string;
} {
  ensureRuntimeLayout(runtimeHome);
  const filePath = settingsFilePath(runtimeHome);
  if (!fs.existsSync(filePath)) {
    const defaults = deriveRuntimeSettingsFromEnv(runtimeHome);
    writeRuntimeSettings(runtimeHome, defaults);
    return { settings: defaults, filePath };
  }

  return {
    settings: loadRuntimeSettingsFromPath(filePath),
    filePath,
  };
}

export function loadRuntimeSettings(runtimeHome: string): RuntimeSettings {
  return ensureSettingsLoaded(runtimeHome).settings;
}

export function saveRuntimeSettings(
  runtimeHome: string,
  settings: RuntimeSettings,
): void {
  ensureRuntimeLayout(runtimeHome);
  writeRuntimeSettings(runtimeHome, settings);
}

export function updateRuntimeSettingsFromOnboarding(input: {
  runtimeHome: string;
  telegramEnabled: boolean;
  memoryEnabled: boolean;
  embeddingsEnabled: boolean;
  dreamingEnabled: boolean;
}): void {
  const loaded = ensureSettingsLoaded(input.runtimeHome);
  const merged: RuntimeSettings = {
    ...loaded.settings,
    channels: {
      ...loaded.settings.channels,
      telegram: {
        ...loaded.settings.channels.telegram,
        enabled: input.telegramEnabled,
      },
    },
    features: {
      memory: input.memoryEnabled,
      embeddings: input.embeddingsEnabled,
      dreaming: input.dreamingEnabled,
    },
  };
  writeRuntimeSettings(input.runtimeHome, merged);
}

function validateSenderAllowlistFolders(input: {
  channel: RuntimeChannel;
  config: SenderAllowlistConfig;
  knownFolders: Set<string>;
  details: string[];
  filePath: string;
}): void {
  for (const folder of Object.keys(input.config.agents).sort((a, b) =>
    a.localeCompare(b),
  )) {
    if (!input.knownFolders.has(folder)) {
      input.details.push(
        `${input.filePath} has channels.${input.channel}.sender_allowlist.agents.${folder}, but no registered ${input.channel} agent uses folder "${folder}". Run \`myclaw agent list\` and use an existing folder name.`,
      );
    }
  }
}

export function validateRuntimeSettings(
  runtimeHome: string,
): RuntimeSettingsValidationResult {
  const envPath = envFilePath(runtimeHome);
  let loaded: { settings: RuntimeSettings; filePath: string };

  try {
    loaded = ensureSettingsLoaded(runtimeHome);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      failure: {
        summary: 'Runtime settings file is invalid.',
        details: [
          `Fix ${settingsFilePath(runtimeHome)} and retry.`,
          `Validation error: ${message}`,
        ],
      },
    };
  }

  const settings = loaded.settings;
  const details: string[] = [];
  const env = readEnvFile(envPath);

  if (!settings.channels.telegram.enabled && !settings.channels.slack.enabled) {
    details.push(
      `Enable at least one channel in ${loaded.filePath} before restart.`,
    );
  }

  if (settings.channels.telegram.enabled && !env.TELEGRAM_BOT_TOKEN?.trim()) {
    details.push(
      `Telegram is enabled in ${loaded.filePath} but TELEGRAM_BOT_TOKEN is missing in ${envPath}.`,
    );
  }

  if (settings.channels.slack.enabled) {
    if (!env.SLACK_BOT_TOKEN?.trim()) {
      details.push(
        `Slack is enabled in ${loaded.filePath} but SLACK_BOT_TOKEN is missing in ${envPath}.`,
      );
    }
    if (!env.SLACK_APP_TOKEN?.trim()) {
      details.push(
        `Slack is enabled in ${loaded.filePath} but SLACK_APP_TOKEN is missing in ${envPath}.`,
      );
    }
  }

  const telegramGroups = getRegisteredGroupSummary(runtimeHome, 'tg:%');
  if (telegramGroups.error) {
    details.push(
      `Could not inspect Telegram registered chats in ${path.join(runtimeHome, 'store', 'messages.db')}: ${telegramGroups.error}`,
    );
  } else {
    if (settings.channels.telegram.enabled && telegramGroups.count < 1) {
      details.push(
        'Telegram is enabled but no Telegram chats are registered. Run `myclaw telegram connect`.',
      );
    }
    validateSenderAllowlistFolders({
      channel: 'telegram',
      config: settings.channels.telegram.senderAllowlist,
      knownFolders: telegramGroups.folders,
      details,
      filePath: loaded.filePath,
    });
  }

  const slackGroups = getRegisteredGroupSummary(runtimeHome, 'sl:%');
  if (slackGroups.error) {
    details.push(
      `Could not inspect Slack registered chats in ${path.join(runtimeHome, 'store', 'messages.db')}: ${slackGroups.error}`,
    );
  } else {
    if (settings.channels.slack.enabled && slackGroups.count < 1) {
      details.push(
        'Slack is enabled but no Slack chats are registered. Run `myclaw slack connect`.',
      );
    }
    validateSenderAllowlistFolders({
      channel: 'slack',
      config: settings.channels.slack.senderAllowlist,
      knownFolders: slackGroups.folders,
      details,
      filePath: loaded.filePath,
    });
  }

  if (details.length > 0) {
    return {
      ok: false,
      failure: {
        summary: 'Runtime settings validation failed.',
        details,
      },
    };
  }

  return { ok: true, settings };
}
