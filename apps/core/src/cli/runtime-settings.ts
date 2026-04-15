import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

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
  chats: Record<string, ChatAllowlistEntry>;
  logDenied: boolean;
}

export interface RuntimeSettings {
  version: 2;
  channels: {
    telegram: { enabled: boolean };
    slack: { enabled: boolean };
  };
  features: {
    memory: boolean;
    embeddings: boolean;
    dreaming: boolean;
  };
  messagePolicy: {
    senderAllowlist: SenderAllowlistConfig;
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
  chats: {},
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

function parseRuntimeSettings(raw: string): RuntimeSettings {
  const parsed = raw.trimStart().startsWith('{')
    ? (JSON.parse(raw) as unknown)
    : (parseSimpleYamlObject(raw) as unknown);

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('root must be a mapping');
  }

  const root = parsed as Record<string, unknown>;
  if (root.version !== 2) {
    throw new Error('version must be set to 2');
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

  const telegram = channelsMap.telegram;
  if (
    typeof telegram !== 'object' ||
    telegram === null ||
    Array.isArray(telegram)
  ) {
    throw new Error('channels.telegram must be a mapping');
  }
  const telegramEnabled = (telegram as Record<string, unknown>).enabled;
  if (typeof telegramEnabled !== 'boolean') {
    throw new Error('channels.telegram.enabled must be true/false');
  }

  const slack = channelsMap.slack;
  if (typeof slack !== 'object' || slack === null || Array.isArray(slack)) {
    throw new Error('channels.slack must be a mapping');
  }
  const slackEnabled = (slack as Record<string, unknown>).enabled;
  if (typeof slackEnabled !== 'boolean') {
    throw new Error('channels.slack.enabled must be true/false');
  }

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

  const messagePolicy = root.message_policy;
  if (
    typeof messagePolicy !== 'object' ||
    messagePolicy === null ||
    Array.isArray(messagePolicy)
  ) {
    throw new Error('message_policy must be a mapping');
  }
  const messagePolicyMap = messagePolicy as Record<string, unknown>;

  const senderAllowlistRaw = messagePolicyMap.sender_allowlist;
  if (
    typeof senderAllowlistRaw !== 'object' ||
    senderAllowlistRaw === null ||
    Array.isArray(senderAllowlistRaw)
  ) {
    throw new Error('message_policy.sender_allowlist must be a mapping');
  }
  const senderAllowlistMap = senderAllowlistRaw as Record<string, unknown>;

  if (!isValidAllowlistEntry(senderAllowlistMap.default)) {
    throw new Error(
      'message_policy.sender_allowlist.default must include allow and mode',
    );
  }

  const chatsRaw = senderAllowlistMap.chats;
  if (
    typeof chatsRaw !== 'object' ||
    chatsRaw === null ||
    Array.isArray(chatsRaw)
  ) {
    throw new Error('message_policy.sender_allowlist.chats must be a mapping');
  }
  const chatsMap = chatsRaw as Record<string, unknown>;
  const chats: Record<string, ChatAllowlistEntry> = {};
  for (const [chatJid, entry] of Object.entries(chatsMap)) {
    if (!chatJid.trim()) {
      throw new Error('message_policy.sender_allowlist.chats has empty key');
    }
    if (!isValidAllowlistEntry(entry)) {
      throw new Error(
        `message_policy.sender_allowlist.chats.${chatJid} is invalid`,
      );
    }
    chats[chatJid] = {
      allow:
        entry.allow === '*'
          ? '*'
          : (entry.allow as string[]).map((v) => v.trim()),
      mode: entry.mode,
    };
  }

  const logDeniedRaw = senderAllowlistMap.log_denied;
  if (typeof logDeniedRaw !== 'boolean') {
    throw new Error(
      'message_policy.sender_allowlist.log_denied must be true/false',
    );
  }

  const defaultEntry = senderAllowlistMap.default as ChatAllowlistEntry;
  return {
    version: 2,
    channels: {
      telegram: { enabled: telegramEnabled },
      slack: { enabled: slackEnabled },
    },
    features: {
      memory,
      embeddings,
      dreaming,
    },
    messagePolicy: {
      senderAllowlist: {
        default: {
          allow:
            defaultEntry.allow === '*'
              ? '*'
              : defaultEntry.allow.map((item) => item.trim()),
          mode: defaultEntry.mode,
        },
        chats,
        logDenied: logDeniedRaw,
      },
    },
  };
}

function countRegisteredGroupsForPrefix(
  runtimeHome: string,
  prefix: 'tg:%' | 'sl:%',
): { count: number; error?: string } {
  const dbPath = path.join(runtimeHome, 'store', 'messages.db');
  if (!fs.existsSync(dbPath)) {
    return { count: 0 };
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare(
        `SELECT COUNT(*) as count FROM registered_groups WHERE jid LIKE ?`,
      )
      .get(prefix) as { count: number };
    return { count: row.count };
  } catch (err) {
    return {
      count: 0,
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

function renderRuntimeSettingsYaml(settings: RuntimeSettings): string {
  const lines = [
    'version: 2',
    'channels:',
    `  telegram:`,
    `    enabled: ${settings.channels.telegram.enabled ? 'true' : 'false'}`,
    `  slack:`,
    `    enabled: ${settings.channels.slack.enabled ? 'true' : 'false'}`,
    'features:',
    `  memory: ${settings.features.memory ? 'true' : 'false'}`,
    `  embeddings: ${settings.features.embeddings ? 'true' : 'false'}`,
    `  dreaming: ${settings.features.dreaming ? 'true' : 'false'}`,
    'message_policy:',
    '  sender_allowlist:',
    '    default:',
    `      allow: ${renderAllowValue(settings.messagePolicy.senderAllowlist.default.allow)}`,
    `      mode: ${settings.messagePolicy.senderAllowlist.default.mode}`,
    '    chats:',
  ];

  const chatEntries = Object.entries(
    settings.messagePolicy.senderAllowlist.chats,
  ).sort(([a], [b]) => a.localeCompare(b));
  for (const [chatJid, entry] of chatEntries) {
    lines.push(`      ${quoteYamlKey(chatJid)}:`);
    lines.push(`        allow: ${renderAllowValue(entry.allow)}`);
    lines.push(`        mode: ${entry.mode}`);
  }

  lines.push(
    `    log_denied: ${settings.messagePolicy.senderAllowlist.logDenied ? 'true' : 'false'}`,
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

export function deriveRuntimeSettingsFromEnv(
  runtimeHome: string,
): RuntimeSettings {
  const env = readEnvFile(envFilePath(runtimeHome));
  const memoryEnabled = (env.MEMORY_PROVIDER || 'sqlite') !== 'noop';
  const embeddingsEnabled =
    memoryEnabled && (env.MEMORY_EMBED_PROVIDER || 'disabled') === 'openai';
  const dreamingEnabled = parseBoolean(env.MEMORY_DREAMING_ENABLED, false);

  return {
    version: 2,
    channels: {
      telegram: { enabled: Boolean(env.TELEGRAM_BOT_TOKEN?.trim()) },
      slack: {
        enabled: Boolean(
          env.SLACK_BOT_TOKEN?.trim() && env.SLACK_APP_TOKEN?.trim(),
        ),
      },
    },
    features: {
      memory: memoryEnabled,
      embeddings: embeddingsEnabled,
      dreaming: dreamingEnabled,
    },
    messagePolicy: {
      senderAllowlist: {
        default: {
          allow: DEFAULT_SENDER_ALLOWLIST.default.allow,
          mode: DEFAULT_SENDER_ALLOWLIST.default.mode,
        },
        chats: {},
        logDenied: DEFAULT_SENDER_ALLOWLIST.logDenied,
      },
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
      telegram: { enabled: input.telegramEnabled },
    },
    features: {
      memory: input.memoryEnabled,
      embeddings: input.embeddingsEnabled,
      dreaming: input.dreamingEnabled,
    },
  };
  writeRuntimeSettings(input.runtimeHome, merged);
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

  if (settings.channels.telegram.enabled) {
    const telegramGroups = countRegisteredGroupsForPrefix(runtimeHome, 'tg:%');
    if (telegramGroups.error) {
      details.push(
        `Could not inspect Telegram registered chats in ${path.join(runtimeHome, 'store', 'messages.db')}: ${telegramGroups.error}`,
      );
    } else if (telegramGroups.count < 1) {
      details.push(
        'Telegram is enabled but no Telegram chats are registered. Run `myclaw telegram connect`.',
      );
    }
  }

  if (settings.channels.slack.enabled) {
    const slackGroups = countRegisteredGroupsForPrefix(runtimeHome, 'sl:%');
    if (slackGroups.error) {
      details.push(
        `Could not inspect Slack registered chats in ${path.join(runtimeHome, 'store', 'messages.db')}: ${slackGroups.error}`,
      );
    } else if (slackGroups.count < 1) {
      details.push(
        'Slack is enabled but no Slack chats are registered. Run `myclaw slack connect`.',
      );
    }
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
