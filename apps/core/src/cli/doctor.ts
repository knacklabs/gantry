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
  hasAppleContainer,
  hasDocker,
  hasSystemdUser,
  isDockerRunning,
} from './platform.js';
import { envFilePath, ensureRuntimeWritable } from './runtime-home.js';
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

  const hasContainerRuntime = hasAppleContainer() || hasDocker();
  const dockerRunning = isDockerRunning();
  if (hasContainerRuntime && (hasAppleContainer() || dockerRunning)) {
    const runtimeName = hasAppleContainer()
      ? 'Apple Container'
      : dockerRunning
        ? 'Docker (running)'
        : 'Docker';
    add(checks, {
      id: 'container-runtime',
      title: 'Container Runtime',
      status: 'pass',
      message: `${runtimeName} is available.`,
    });
  } else if (hasDocker() && !dockerRunning) {
    add(checks, {
      id: 'container-runtime',
      title: 'Container Runtime',
      status: 'warn',
      message: 'Docker is installed but not running.',
      nextAction:
        'Start Docker Desktop (or Docker daemon) before running MyClaw in container mode.',
    });
  } else {
    add(checks, {
      id: 'container-runtime',
      title: 'Container Runtime',
      status: 'warn',
      message: 'No container runtime detected.',
      nextAction:
        'Install Docker Desktop (or Apple Container on macOS). MyClaw can still run in host mode.',
    });
  }

  const envPath = envFilePath(runtimeHome);
  const env = readEnvFile(envPath);
  const hasTelegram = Boolean(env.TELEGRAM_BOT_TOKEN?.trim());
  add(checks, {
    id: 'telegram-token',
    title: 'Telegram Token',
    status: hasTelegram ? 'pass' : 'warn',
    message: hasTelegram
      ? 'Telegram token is configured.'
      : `Telegram token is missing in ${envPath}.`,
    nextAction: hasTelegram
      ? undefined
      : 'Run `myclaw telegram connect` to configure your bot token.',
  });

  const hasSlackBotToken = Boolean(env.SLACK_BOT_TOKEN?.trim());
  const hasSlackAppToken = Boolean(env.SLACK_APP_TOKEN?.trim());
  const slackConfigured = hasSlackBotToken && hasSlackAppToken;
  add(checks, {
    id: 'slack-tokens',
    title: 'Slack Tokens',
    status: slackConfigured
      ? 'pass'
      : hasSlackBotToken || hasSlackAppToken
        ? 'warn'
        : 'warn',
    message: slackConfigured
      ? 'Slack bot/app tokens are configured.'
      : hasSlackBotToken || hasSlackAppToken
        ? 'Slack token setup is incomplete (both bot and app tokens are required).'
        : `Slack tokens are missing in ${envPath}.`,
    nextAction: slackConfigured
      ? undefined
      : 'Run `myclaw slack connect` to configure Slack Socket Mode credentials.',
  });

  const embedProvider = env.MEMORY_EMBED_PROVIDER || 'disabled';
  const hasOpenAIKey = Boolean(env.OPENAI_API_KEY?.trim());
  if (embedProvider === 'openai' && !hasOpenAIKey) {
    add(checks, {
      id: 'embeddings-key',
      title: 'OpenAI Embeddings',
      status: 'warn',
      message: 'Embeddings are set to OpenAI but OPENAI_API_KEY is missing.',
      nextAction: 'Add OPENAI_API_KEY or disable embeddings in `myclaw setup`.',
    });
  } else {
    add(checks, {
      id: 'embeddings-key',
      title: 'OpenAI Embeddings',
      status: 'pass',
      message:
        embedProvider === 'openai'
          ? 'OpenAI embeddings are enabled and key is present.'
          : 'Embeddings are disabled (default).',
    });
  }

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
  const envPath = envFilePath(runtimeHome);
  if (!fs.existsSync(envPath)) return false;
  const env = readEnvFile(envPath);
  const hasTelegram = Boolean(env.TELEGRAM_BOT_TOKEN?.trim());
  const hasSlack = Boolean(
    env.SLACK_BOT_TOKEN?.trim() && env.SLACK_APP_TOKEN?.trim(),
  );
  return hasTelegram || hasSlack;
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
  const envPath = envFilePath(runtimeHome);
  if (!fs.existsSync(envPath)) return false;
  const env = readEnvFile(envPath);
  const telegramConfigured = Boolean(env.TELEGRAM_BOT_TOKEN?.trim());
  const slackConfigured = Boolean(
    env.SLACK_BOT_TOKEN?.trim() && env.SLACK_APP_TOKEN?.trim(),
  );

  if (telegramConfigured) {
    const telegramGroups = inspectTelegramGroupCount(runtimeHome);
    if (!telegramGroups.error && telegramGroups.count > 0) return true;
  }

  if (slackConfigured) {
    const slackGroups = inspectSlackGroupCount(runtimeHome);
    if (!slackGroups.error && slackGroups.count > 0) return true;
  }

  return false;
}
