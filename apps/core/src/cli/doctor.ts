import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

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

function inspectTelegramGroupCount(runtimeHome: string): {
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
        `SELECT COUNT(*) as count FROM registered_groups WHERE jid LIKE 'tg:%'`,
      )
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

function inspectSlackGroupCount(runtimeHome: string): {
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
        `SELECT COUNT(*) as count FROM registered_groups WHERE jid LIKE 'sl:%'`,
      )
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

  add(checks, {
    id: 'runtime-mode',
    title: 'Runtime Mode',
    status: 'pass',
    message: 'Host runtime is active and officially supported.',
  });

  const settingsResult = loadSettingsForDoctor(runtimeHome);
  const settings = settingsResult.settings;
  const telegramEnabled = settings?.channels.telegram.enabled ?? false;
  const slackEnabled = settings?.channels.slack.enabled ?? false;
  if (settings) {
    if (telegramEnabled || slackEnabled) {
      add(checks, {
        id: 'runtime-settings',
        title: 'Runtime Settings',
        status: 'pass',
        message: `Runtime settings loaded from ${path.join(runtimeHome, 'settings.yaml')}.`,
      });
    } else {
      add(checks, {
        id: 'runtime-settings',
        title: 'Runtime Settings',
        status: 'fail',
        message:
          'Runtime settings are valid, but no channels are enabled in settings.yaml.',
        nextAction:
          'Run `myclaw telegram connect` or `myclaw slack connect` to enable a channel.',
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
  const hasTelegramToken = Boolean(env.TELEGRAM_BOT_TOKEN?.trim());
  if (!telegramEnabled) {
    add(checks, {
      id: 'telegram-token',
      title: 'Telegram Token',
      status: 'pass',
      message: 'Telegram channel is disabled in settings.yaml.',
    });
  } else {
    add(checks, {
      id: 'telegram-token',
      title: 'Telegram Token',
      status: hasTelegramToken ? 'pass' : 'warn',
      message: hasTelegramToken
        ? 'Telegram token is configured.'
        : `Telegram token is missing in ${envPath}.`,
      nextAction: hasTelegramToken
        ? undefined
        : 'Run `myclaw telegram connect` to configure your bot token.',
    });
  }

  const hasSlackBotToken = Boolean(env.SLACK_BOT_TOKEN?.trim());
  const hasSlackAppToken = Boolean(env.SLACK_APP_TOKEN?.trim());
  const slackTokensConfigured = hasSlackBotToken && hasSlackAppToken;
  if (!slackEnabled) {
    add(checks, {
      id: 'slack-tokens',
      title: 'Slack Tokens',
      status: 'pass',
      message: 'Slack channel is disabled in settings.yaml.',
    });
  } else {
    add(checks, {
      id: 'slack-tokens',
      title: 'Slack Tokens',
      status: slackTokensConfigured ? 'pass' : 'warn',
      message: slackTokensConfigured
        ? 'Slack bot/app tokens are configured.'
        : hasSlackBotToken || hasSlackAppToken
          ? 'Slack token setup is incomplete (both bot and app tokens are required).'
          : `Slack tokens are missing in ${envPath}.`,
      nextAction: slackTokensConfigured
        ? undefined
        : 'Run `myclaw slack connect` to configure Slack Socket Mode credentials.',
    });
  }

  const embeddingsEnabled = settings?.features.embeddings ?? false;
  const hasOpenAIKey = Boolean(env.OPENAI_API_KEY?.trim());
  if (embeddingsEnabled && !hasOpenAIKey) {
    add(checks, {
      id: 'embeddings-key',
      title: 'OpenAI Embeddings',
      status: 'warn',
      message:
        'Embeddings are enabled in settings.yaml but OPENAI_API_KEY is missing.',
      nextAction: 'Add OPENAI_API_KEY or disable embeddings in `myclaw setup`.',
    });
  } else {
    add(checks, {
      id: 'embeddings-key',
      title: 'OpenAI Embeddings',
      status: 'pass',
      message: embeddingsEnabled
        ? 'OpenAI embeddings are enabled and key is present.'
        : 'Embeddings are disabled in settings.yaml.',
    });
  }

  if (telegramEnabled) {
    const telegramGroups = inspectTelegramGroupCount(runtimeHome);
    if (telegramGroups.error) {
      add(checks, {
        id: 'telegram-groups',
        title: 'Telegram Group Registry',
        status: 'fail',
        message:
          'Could not read registered Telegram groups; runtime database may be corrupted.',
        nextAction: `Repair or replace ${path.join(runtimeHome, 'store', 'messages.db')}. Details: ${telegramGroups.error}`,
      });
    } else if (telegramGroups.count > 0) {
      add(checks, {
        id: 'telegram-groups',
        title: 'Telegram Group Registry',
        status: 'pass',
        message: `${telegramGroups.count} Telegram group(s) registered.`,
      });
    } else {
      add(checks, {
        id: 'telegram-groups',
        title: 'Telegram Group Registry',
        status: 'warn',
        message: 'No Telegram groups are registered.',
        nextAction:
          'Run `myclaw telegram connect` (or `myclaw agent add <chat-id>`) to connect a chat.',
      });
    }
  } else {
    add(checks, {
      id: 'telegram-groups',
      title: 'Telegram Group Registry',
      status: 'pass',
      message: 'Telegram channel is disabled in settings.yaml.',
    });
  }

  if (slackEnabled) {
    const slackGroups = inspectSlackGroupCount(runtimeHome);
    if (slackGroups.error) {
      add(checks, {
        id: 'slack-groups',
        title: 'Slack Group Registry',
        status: 'fail',
        message:
          'Could not read registered Slack groups; runtime database may be corrupted.',
        nextAction: `Repair or replace ${path.join(runtimeHome, 'store', 'messages.db')}. Details: ${slackGroups.error}`,
      });
    } else if (slackGroups.count > 0) {
      add(checks, {
        id: 'slack-groups',
        title: 'Slack Group Registry',
        status: 'pass',
        message: `${slackGroups.count} Slack group(s) registered.`,
      });
    } else {
      add(checks, {
        id: 'slack-groups',
        title: 'Slack Group Registry',
        status: 'warn',
        message: 'No Slack groups are registered.',
        nextAction:
          'Run `myclaw slack connect` (or `myclaw agent add sl:<channel-id>`) to connect Slack.',
      });
    }
  } else {
    add(checks, {
      id: 'slack-groups',
      title: 'Slack Group Registry',
      status: 'pass',
      message: 'Slack channel is disabled in settings.yaml.',
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

  const settings = loadSettingsForDoctor(runtimeHome).settings;
  if (!settings?.channels.telegram.enabled) {
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
    return (
      settings.channels.telegram.enabled || settings.channels.slack.enabled
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

  if (settings.channels.telegram.enabled && env.TELEGRAM_BOT_TOKEN?.trim()) {
    const telegramGroups = inspectTelegramGroupCount(runtimeHome);
    if (!telegramGroups.error && telegramGroups.count > 0) return true;
  }

  if (
    settings.channels.slack.enabled &&
    env.SLACK_BOT_TOKEN?.trim() &&
    env.SLACK_APP_TOKEN?.trim()
  ) {
    const slackGroups = inspectSlackGroupCount(runtimeHome);
    if (!slackGroups.error && slackGroups.count > 0) return true;
  }

  return false;
}
