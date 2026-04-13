import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

import { readEnvFile } from './env-file.js';
import {
  assertRuntimeEntryExists,
  getRuntimeEntryPath,
} from './package-paths.js';
import {
  detectPlatform,
  getNodeMajorVersion,
  getNodeVersion,
  hasAppleContainer,
  hasDocker,
  hasSystemdUser,
  isDockerRunning,
} from './platform.js';
import { envFilePath, ensureRuntimeWritable } from './runtime-home.js';

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

function statusLabel(status: DoctorStatus): string {
  if (status === 'pass') return 'PASS';
  if (status === 'warn') return 'WARN';
  return 'FAIL';
}

function add(checks: DoctorCheck[], check: DoctorCheck): void {
  checks.push(check);
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
  return Boolean(env.TELEGRAM_BOT_TOKEN?.trim());
}

export function hasRegisteredTelegramGroup(runtimeHome: string): boolean {
  const dbPath = path.join(runtimeHome, 'store', 'messages.db');
  if (!fs.existsSync(dbPath)) return false;
  try {
    const db = new Database(dbPath, { readonly: true });
    const row = db
      .prepare(
        `SELECT COUNT(*) as count FROM registered_groups WHERE jid LIKE 'tg:%'`,
      )
      .get() as { count: number };
    db.close();
    return row.count > 0;
  } catch {
    return false;
  }
}
