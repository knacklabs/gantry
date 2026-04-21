import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import '../channels/register-builtins.js';
import {
  getChannelProvider,
  listChannelProviders,
} from '../channels/provider-registry.js';

import { readEnvFile } from './env-file.js';
import {
  assertRuntimeEntryExists,
  getRuntimeEntryPath,
} from './package-paths.js';
import {
  commandExists,
  detectPlatform,
  getNodeMajorVersion,
  getNodeVersion,
  hasSystemdUser,
} from './platform.js';
import { envFilePath, ensureRuntimeWritable } from './runtime-home.js';
import { ensureRuntimeSettings, RuntimeSettings } from './runtime-settings.js';
import { validateTelegramBotToken } from './telegram.js';
import { inspectMemoryHealth } from './memory-health.js';

export type DoctorStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  id: string;
  title: string;
  status: DoctorStatus;
  message: string;
  nextAction?: string;
}

export interface DoctorReport {
  ok: boolean;
  blockingFailures: number;
  warnings: number;
  checks: DoctorCheck[];
}

export interface DoctorNetworkOptions {
  validateTelegramToken?: boolean;
  telegramTimeoutMs?: number;
}

type ClaudeAuthMode = 'oauth' | 'api_key' | 'none';

function resolveClaudeAuthState(input: {
  oauthToken?: string;
  apiKey?: string;
}): {
  hasOauthToken: boolean;
  hasApiKey: boolean;
  mode: ClaudeAuthMode;
} {
  const oauthToken = input.oauthToken?.trim() || '';
  const apiKey = input.apiKey?.trim() || '';
  const hasOauthToken = Boolean(oauthToken);
  const hasApiKey = Boolean(apiKey);
  const mode: ClaudeAuthMode = hasOauthToken
    ? 'oauth'
    : hasApiKey
      ? 'api_key'
      : 'none';
  return { hasOauthToken, hasApiKey, mode };
}

function statusLabel(status: DoctorStatus): string {
  if (status === 'pass') return 'PASS';
  if (status === 'warn') return 'WARN';
  return 'FAIL';
}

function add(checks: DoctorCheck[], check: DoctorCheck): void {
  checks.push(check);
}

function addToReport(report: DoctorReport, check: DoctorCheck): DoctorReport {
  const checks = [...report.checks, check];
  const blockingFailures = checks.filter(
    (entry) => entry.status === 'fail',
  ).length;
  const warnings = checks.filter((entry) => entry.status === 'warn').length;
  return {
    checks,
    blockingFailures,
    warnings,
    ok: blockingFailures === 0,
  };
}

function inspectProviderGroupCount(
  runtimeHome: string,
  jidPrefix: string,
): {
  count: number;
  error?: string;
} {
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
      .get(`${jidPrefix}%`) as { count: number };
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
      // Ignore close errors and preserve primary failure.
    }
  }
}

function inspectTelegramGroupCount(runtimeHome: string): {
  count: number;
  error?: string;
} {
  return inspectProviderGroupCount(runtimeHome, 'tg:');
}

function inspectSlackGroupCount(runtimeHome: string): {
  count: number;
  error?: string;
} {
  return inspectProviderGroupCount(runtimeHome, 'sl:');
}

function inspectRegisteredGroupCount(runtimeHome: string): {
  count: number;
  error?: string;
} {
  const dbPath = path.join(runtimeHome, 'store', 'messages.db');
  if (!fs.existsSync(dbPath)) {
    return { count: 0 };
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare(`SELECT COUNT(*) as count FROM registered_groups`)
      .get() as { count: number };
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
      // Ignore close errors and preserve primary failure.
    }
  }
}

function inspectRegisteredGroupFolders(runtimeHome: string): {
  folders: string[];
  error?: string;
} {
  const dbPath = path.join(runtimeHome, 'store', 'messages.db');
  if (!fs.existsSync(dbPath)) {
    return { folders: [] };
  }

  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    const rows = db
      .prepare(
        `SELECT folder FROM registered_groups WHERE folder IS NOT NULL AND TRIM(folder) != ''`,
      )
      .all() as Array<{ folder: string }>;
    const folders = rows
      .map((row) => String(row.folder || '').trim())
      .filter((value) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value));
    return { folders: [...new Set(folders)] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/no such column:\\s*folder/i.test(message)) {
      return { folders: [] };
    }
    return { folders: [], error: message };
  } finally {
    try {
      db?.close();
    } catch {
      // Ignore close errors and preserve primary failure.
    }
  }
}

function loadSettingsForDoctor(runtimeHome: string): {
  settings?: RuntimeSettings;
  error?: string;
} {
  try {
    return { settings: ensureRuntimeSettings(runtimeHome) };
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function runDoctor(
  importMetaUrl: string,
  runtimeHome: string,
): DoctorReport {
  const checks: DoctorCheck[] = [];

  const nodeMajor = getNodeMajorVersion();
  const nodeVersion = getNodeVersion();
  if (nodeMajor >= 20) {
    add(checks, {
      id: 'node-version',
      title: 'Node.js Version',
      status: 'pass',
      message: `Node ${nodeVersion} detected.`,
    });
  } else {
    add(checks, {
      id: 'node-version',
      title: 'Node.js Version',
      status: 'fail',
      message: `Node ${nodeVersion} detected. MyClaw requires Node 20 or newer.`,
      nextAction: 'Install Node.js 20+ and run `myclaw doctor` again.',
    });
  }

  try {
    assertRuntimeEntryExists(importMetaUrl);
    add(checks, {
      id: 'runtime-entry',
      title: 'Runtime Files',
      status: 'pass',
      message: `Runtime entry found at ${getRuntimeEntryPath(importMetaUrl)}.`,
    });
  } catch (err) {
    add(checks, {
      id: 'runtime-entry',
      title: 'Runtime Files',
      status: 'fail',
      message: err instanceof Error ? err.message : String(err),
      nextAction: 'Reinstall MyClaw from npm, then run `myclaw doctor` again.',
    });
  }

  try {
    ensureRuntimeWritable(runtimeHome);
    add(checks, {
      id: 'runtime-home',
      title: 'Runtime Home',
      status: 'pass',
      message: `Runtime home is writable: ${runtimeHome}`,
    });
  } catch (err) {
    add(checks, {
      id: 'runtime-home',
      title: 'Runtime Home',
      status: 'fail',
      message: `Cannot write to runtime home ${runtimeHome}.`,
      nextAction:
        err instanceof Error
          ? `Fix permissions or choose another runtime home. Details: ${err.message}`
          : 'Fix runtime-home permissions or choose a different path.',
    });
  }

  const ipcBaseDir = path.join(runtimeHome, 'data', 'ipc');
  const ipcSubdirs = [
    'messages',
    'tasks',
    'input',
    'memory-requests',
    'memory-responses',
    'permission-requests',
    'permission-responses',
    'browser-requests',
    'browser-responses',
    'user-questions',
    'user-answers',
    'plan-events',
    'plan-responses',
    'task-responses',
  ];
  try {
    fs.mkdirSync(ipcBaseDir, { recursive: true });
    const ipcFolders = inspectRegisteredGroupFolders(runtimeHome);
    if (ipcFolders.error) {
      add(checks, {
        id: 'ipc-layout',
        title: 'IPC Layout',
        status: 'warn',
        message:
          'IPC base directory is writable, but registered group folders could not be inspected.',
        nextAction: `Check ${path.join(runtimeHome, 'store', 'messages.db')}. Details: ${ipcFolders.error}`,
      });
    } else {
      for (const folder of ipcFolders.folders) {
        for (const subdir of ipcSubdirs) {
          fs.mkdirSync(path.join(ipcBaseDir, folder, subdir), {
            recursive: true,
          });
        }
      }
      add(checks, {
        id: 'ipc-layout',
        title: 'IPC Layout',
        status: 'pass',
        message:
          ipcFolders.folders.length > 0
            ? `IPC layout is ready for ${ipcFolders.folders.length} registered group folder(s).`
            : 'IPC base directory is writable.',
      });
    }
  } catch (err) {
    add(checks, {
      id: 'ipc-layout',
      title: 'IPC Layout',
      status: 'fail',
      message: `IPC layout is not writable at ${ipcBaseDir}.`,
      nextAction:
        err instanceof Error
          ? `Fix runtime-home permissions. Details: ${err.message}`
          : 'Fix runtime-home permissions and rerun doctor.',
    });
  }

  const settingsResult = loadSettingsForDoctor(runtimeHome);
  const settings = settingsResult.settings;
  const providers = listChannelProviders();
  const enabledProviders = settings
    ? providers.filter((provider) => settings.channels[provider.id]?.enabled)
    : [];
  if (settings) {
    if (enabledProviders.length > 0) {
      add(checks, {
        id: 'runtime-settings',
        title: 'Runtime Settings',
        status: 'pass',
        message: `Runtime settings loaded from ${path.join(runtimeHome, 'settings.yaml')} with canonical memory block.`,
      });
    } else {
      add(checks, {
        id: 'runtime-settings',
        title: 'Runtime Settings',
        status: 'fail',
        message:
          'Runtime settings are valid, but no channels are enabled in settings.yaml.',
        nextAction: `Run ${providers.map((provider) => `\`myclaw ${provider.id} connect\``).join(' or ')} to enable a channel.`,
      });
    }
  } else {
    add(checks, {
      id: 'runtime-settings',
      title: 'Runtime Settings',
      status: 'fail',
      message: 'Runtime settings file is invalid.',
      nextAction: `Fix ${path.join(runtimeHome, 'settings.yaml')}. Details: ${settingsResult.error}`,
    });
  }

  const envPath = envFilePath(runtimeHome);
  const env = readEnvFile(envPath);
  const claudeAuth = resolveClaudeAuthState({
    oauthToken: env.CLAUDE_CODE_OAUTH_TOKEN,
    apiKey: env.ANTHROPIC_API_KEY,
  });

  for (const provider of providers) {
    const enabled = settings?.channels[provider.id]?.enabled ?? false;
    const configuredKeys = provider.setup.envKeys.filter((envKey) =>
      Boolean(env[envKey]?.trim()),
    );
    const missingKeys = provider.setup.envKeys.filter(
      (envKey) => !env[envKey]?.trim(),
    );
    const envCheckId =
      provider.id === 'telegram'
        ? 'telegram-token'
        : provider.id === 'slack'
          ? 'slack-tokens'
          : `${provider.id}-credentials`;
    const envCheckTitle =
      provider.id === 'telegram'
        ? 'Telegram Token'
        : provider.id === 'slack'
          ? 'Slack Tokens'
          : `${provider.label} Credentials`;

    if (!enabled) {
      add(checks, {
        id: envCheckId,
        title: envCheckTitle,
        status: 'pass',
        message: `${provider.label} channel is disabled in settings.yaml.`,
      });
    } else if (missingKeys.length === 0) {
      add(checks, {
        id: envCheckId,
        title: envCheckTitle,
        status: 'pass',
        message:
          provider.id === 'telegram'
            ? 'Telegram token is configured.'
            : provider.id === 'slack'
              ? 'Slack bot/app tokens are configured.'
              : `${provider.label} credentials are configured.`,
      });
    } else {
      const partialConfigured = configuredKeys.length > 0;
      add(checks, {
        id: envCheckId,
        title: envCheckTitle,
        status: 'warn',
        message:
          provider.id === 'telegram'
            ? `Telegram token is missing in ${envPath}.`
            : provider.id === 'slack' && partialConfigured
              ? 'Slack token setup is incomplete (both bot and app tokens are required).'
              : `${provider.label} credentials are missing in ${envPath}.`,
        nextAction: `Run \`myclaw ${provider.id} connect\` to configure ${provider.label}.`,
      });
    }
  }

  const memoryHealth = inspectMemoryHealth(runtimeHome, settings, env);
  add(checks, {
    id: 'memory-provider',
    title: 'Memory Storage',
    status: memoryHealth.memoryCheck.status,
    message: `root=${memoryHealth.memoryRoot} (source: ${memoryHealth.memoryRootSource}): ${memoryHealth.memoryCheck.message}`,
    nextAction: memoryHealth.memoryCheck.nextAction,
  });
  add(checks, {
    id: 'embeddings-provider',
    title: 'Memory Embeddings',
    status: memoryHealth.embeddingCheck.status,
    message: `${memoryHealth.embeddingProvider} (source: ${memoryHealth.embeddingProviderSource}): ${memoryHealth.embeddingCheck.message}`,
    nextAction: memoryHealth.embeddingCheck.nextAction,
  });
  add(checks, {
    id: 'claude-auth',
    title: 'Claude Auth',
    status: claudeAuth.mode !== 'none' ? 'pass' : 'warn',
    message:
      claudeAuth.mode !== 'none'
        ? `Claude auth is configured (oauth=${claudeAuth.hasOauthToken ? 'present' : 'missing'}, api_key=${claudeAuth.hasApiKey ? 'present' : 'missing'}, mode=${claudeAuth.mode}).`
        : 'Claude auth is missing. Memory LLM extraction/review paths will fallback.',
    nextAction:
      claudeAuth.mode !== 'none'
        ? undefined
        : 'Set CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY in .env, then rerun `myclaw doctor`.',
  });

  for (const provider of providers) {
    const enabled = settings?.channels[provider.id]?.enabled ?? false;
    const groupCheckId =
      provider.id === 'telegram'
        ? 'telegram-groups'
        : provider.id === 'slack'
          ? 'slack-groups'
          : `${provider.id}-groups`;
    const groupCheckTitle =
      provider.id === 'telegram'
        ? 'Telegram Group Registry'
        : provider.id === 'slack'
          ? 'Slack Group Registry'
          : `${provider.label} Group Registry`;

    if (!enabled) {
      add(checks, {
        id: groupCheckId,
        title: groupCheckTitle,
        status: 'pass',
        message: `${provider.label} channel is disabled in settings.yaml.`,
      });
      continue;
    }

    const groupSummary = inspectProviderGroupCount(
      runtimeHome,
      provider.jidPrefix,
    );
    if (groupSummary.error) {
      add(checks, {
        id: groupCheckId,
        title: groupCheckTitle,
        status: 'fail',
        message: `Could not read registered ${provider.label} groups; runtime database may be corrupted.`,
        nextAction: `Repair or replace ${path.join(runtimeHome, 'store', 'messages.db')}. Details: ${groupSummary.error}`,
      });
      continue;
    }

    if (groupSummary.count > 0) {
      add(checks, {
        id: groupCheckId,
        title: groupCheckTitle,
        status: 'pass',
        message: `${groupSummary.count} ${provider.label} group(s) registered.`,
      });
      continue;
    }

    add(checks, {
      id: groupCheckId,
      title: groupCheckTitle,
      status: 'warn',
      message: `No ${provider.label} groups are registered.`,
      nextAction: `Run \`myclaw ${provider.id} connect\` (or \`myclaw agent add <jid>\`) to connect ${provider.label}.`,
    });
  }

  const platform = detectPlatform();
  if (platform === 'linux') {
    add(checks, {
      id: 'service-manager',
      title: 'Service Manager',
      status: hasSystemdUser() ? 'pass' : 'warn',
      message: hasSystemdUser()
        ? 'systemd user session is available.'
        : 'systemd user session is not available. Background service will use a nohup fallback.',
      nextAction: hasSystemdUser()
        ? undefined
        : 'Use `myclaw service install` to create the fallback start script.',
    });
  } else if (platform === 'windows') {
    add(checks, {
      id: 'service-manager',
      title: 'Service Manager',
      status: 'pass',
      message: 'Background service mode is available on Windows.',
      nextAction: 'Use `myclaw service install` then `myclaw service start`.',
    });
  } else if (platform === 'macos') {
    const hasLaunchctl = commandExists('launchctl');
    add(checks, {
      id: 'service-manager',
      title: 'Service Manager',
      status: hasLaunchctl ? 'pass' : 'warn',
      message: hasLaunchctl
        ? 'launchd is available.'
        : 'launchctl is unavailable in this shell session.',
      nextAction: hasLaunchctl
        ? 'Use `myclaw service install` then `myclaw service start`.'
        : 'Run from a normal macOS user session and retry.',
    });
  }

  const blockingFailures = checks.filter(
    (check) => check.status === 'fail',
  ).length;
  const warnings = checks.filter((check) => check.status === 'warn').length;
  return {
    ok: blockingFailures === 0,
    blockingFailures,
    warnings,
    checks,
  };
}

export async function runDoctorWithNetwork(
  importMetaUrl: string,
  runtimeHome: string,
  options: DoctorNetworkOptions = {},
): Promise<DoctorReport> {
  let report = runDoctor(importMetaUrl, runtimeHome);
  const validateTelegramToken = options.validateTelegramToken !== false;
  if (!validateTelegramToken) {
    return report;
  }

  const telegramProvider = getChannelProvider('telegram');
  if (!telegramProvider) {
    return report;
  }

  const settings = loadSettingsForDoctor(runtimeHome).settings;
  if (!settings?.channels[telegramProvider.id]?.enabled) {
    return report;
  }

  const env = readEnvFile(envFilePath(runtimeHome));
  const token = env.TELEGRAM_BOT_TOKEN?.trim() || '';
  if (!token) {
    return report;
  }

  const validation = await validateTelegramBotToken(
    token,
    options.telegramTimeoutMs,
  );
  if (validation.ok) {
    report = addToReport(report, {
      id: 'telegram-token-api',
      title: 'Telegram Token API Validation',
      status: 'pass',
      message: validation.message,
    });
    return report;
  }

  report = addToReport(report, {
    id: 'telegram-token-api',
    title: 'Telegram Token API Validation',
    status: 'warn',
    message: validation.message,
    nextAction:
      validation.nextAction || 'Refresh TELEGRAM_BOT_TOKEN and rerun doctor.',
  });
  return report;
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push('MyClaw Doctor Report');
  lines.push('');
  for (const check of report.checks) {
    lines.push(
      `[${statusLabel(check.status)}] ${check.title}: ${check.message}`,
    );
    if (check.nextAction) {
      lines.push(`  Next action: ${check.nextAction}`);
    }
  }
  lines.push('');
  lines.push(
    report.ok
      ? `Doctor finished with ${report.warnings} warning(s).`
      : `Doctor found ${report.blockingFailures} blocking issue(s) and ${report.warnings} warning(s).`,
  );
  return lines.join('\n');
}

export function hasRuntimeConfig(runtimeHome: string): boolean {
  try {
    const settings = ensureRuntimeSettings(runtimeHome);
    return listChannelProviders().some(
      (provider) => settings.channels[provider.id]?.enabled,
    );
  } catch {
    return false;
  }
}

export function hasRegisteredTelegramGroup(runtimeHome: string): boolean {
  const inspection = inspectTelegramGroupCount(runtimeHome);
  return !inspection.error && inspection.count > 0;
}

export function hasRegisteredAnyGroup(runtimeHome: string): boolean {
  const inspection = inspectRegisteredGroupCount(runtimeHome);
  return !inspection.error && inspection.count > 0;
}

export function hasProcessableGroupForConfiguredChannel(
  runtimeHome: string,
): boolean {
  let settings: RuntimeSettings;
  try {
    settings = ensureRuntimeSettings(runtimeHome);
  } catch {
    return false;
  }

  const env = readEnvFile(envFilePath(runtimeHome));

  for (const provider of listChannelProviders()) {
    if (!settings.channels[provider.id]?.enabled) continue;
    const hasRequiredCredentials = provider.setup.envKeys.every((envKey) =>
      Boolean(env[envKey]?.trim()),
    );
    if (!hasRequiredCredentials) continue;
    const groups = inspectProviderGroupCount(runtimeHome, provider.jidPrefix);
    if (!groups.error && groups.count > 0) {
      return true;
    }
  }

  return false;
}
