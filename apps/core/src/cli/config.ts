import * as p from '@clack/prompts';

import { readEnvFile, upsertEnvFile } from '../config/env/file.js';
import {
  envFilePath,
  ensureRuntimeLayout,
} from '../config/settings/runtime-home.js';
import { classifyConfigKey } from '../config/source-classification.js';

function usage(): string {
  return [
    'Config commands:',
    '  gantry config list',
    '  gantry config get <KEY> [--raw]',
    '  gantry config set <KEY> <VALUE>',
    '  gantry config unset <KEY>',
  ].join('\n');
}

function isValidEnvKey(key: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(key);
}

function isBlockedDirectProviderCredential(key: string): boolean {
  const classified = classifyConfigKey(key);
  return (
    classified?.lane === 'agent-credential' ||
    classified?.lane === 'non-secret-setting'
  );
}

function blockedKeyMessage(key: string): string {
  return (
    classifyConfigKey(key)?.message ||
    `${key} must not be configured in Gantry .env.`
  );
}

function isSensitiveKey(key: string): boolean {
  // Registered runtime secrets are always masked, whatever their name
  // (e.g. GANTRY_OTEL_TRACES_HEADERS carries an OTLP auth header).
  if (classifyConfigKey(key)?.lane === 'runtime-secret') return true;
  return /(TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY|DATABASE_URL|DB_URL|POSTGRES_URL)/i.test(
    key,
  );
}

function hasUrlUserInfo(value: string): boolean {
  try {
    const parsed = new URL(value);
    return Boolean(parsed.username || parsed.password);
  } catch {
    return false;
  }
}

function maskValue(value: string): string {
  if (!value) return '(empty)';
  if (value.length <= 6) return '*'.repeat(value.length);
  return `${value.slice(0, 3)}***${value.slice(-3)}`;
}

function formatValue(key: string, value: string, raw: boolean): string {
  if (raw || (!isSensitiveKey(key) && !hasUrlUserInfo(value))) {
    return value;
  }
  return maskValue(value);
}

function runList(runtimeHome: string): number {
  ensureRuntimeLayout(runtimeHome);
  const env = readEnvFile(envFilePath(runtimeHome));
  const keys = Object.keys(env).sort((a, b) => a.localeCompare(b));

  if (keys.length === 0) {
    p.log.warn(`No config keys found in ${envFilePath(runtimeHome)}.`);
    return 0;
  }

  const lines = ['Config values:', ''];
  for (const key of keys) {
    lines.push(`${key}=${formatValue(key, env[key], false)}`);
  }
  console.log(lines.join('\n'));
  return 0;
}

function runGet(runtimeHome: string, args: string[]): number {
  const [key, ...rest] = args;
  if (!key) {
    p.log.error('Usage: gantry config get <KEY> [--raw]');
    return 1;
  }
  if (!isValidEnvKey(key)) {
    p.log.error(`Invalid key "${key}". Use uppercase env-style keys.`);
    return 1;
  }
  if (isBlockedDirectProviderCredential(key)) {
    p.log.error(blockedKeyMessage(key));
    return 1;
  }

  const raw = rest.includes('--raw');
  const env = readEnvFile(envFilePath(runtimeHome));
  const value = env[key];
  if (value === undefined) {
    p.log.error(`Key not found: ${key}`);
    return 1;
  }

  console.log(formatValue(key, value, raw));
  return 0;
}

function runSet(runtimeHome: string, args: string[]): number {
  const [key, ...valueParts] = args;
  if (!key || valueParts.length === 0) {
    p.log.error('Usage: gantry config set <KEY> <VALUE>');
    return 1;
  }
  if (!isValidEnvKey(key)) {
    p.log.error(`Invalid key "${key}". Use uppercase env-style keys.`);
    return 1;
  }
  if (isBlockedDirectProviderCredential(key)) {
    p.log.error(blockedKeyMessage(key));
    return 1;
  }

  const value = valueParts.join(' ').trim();
  if (!value) {
    p.log.error(
      'Value cannot be empty. Use `gantry config unset <KEY>` to remove a key.',
    );
    return 1;
  }

  ensureRuntimeLayout(runtimeHome);
  upsertEnvFile(envFilePath(runtimeHome), {
    [key]: value,
  });
  p.log.success(`Updated ${key}.`);
  return 0;
}

function runUnset(runtimeHome: string, args: string[]): number {
  const [key] = args;
  if (!key) {
    p.log.error('Usage: gantry config unset <KEY>');
    return 1;
  }
  if (!isValidEnvKey(key)) {
    p.log.error(`Invalid key "${key}". Use uppercase env-style keys.`);
    return 1;
  }

  ensureRuntimeLayout(runtimeHome);
  upsertEnvFile(envFilePath(runtimeHome), {
    [key]: null,
  });
  p.log.success(`Removed ${key}.`);
  return 0;
}

export function runConfigCommand(runtimeHome: string, args: string[]): number {
  const [subcommand, ...rest] = args;

  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log(usage());
    return subcommand ? 0 : 1;
  }

  if (subcommand === 'list') {
    return runList(runtimeHome);
  }
  if (subcommand === 'get') {
    return runGet(runtimeHome, rest);
  }
  if (subcommand === 'set') {
    return runSet(runtimeHome, rest);
  }
  if (subcommand === 'unset') {
    return runUnset(runtimeHome, rest);
  }

  p.log.error(`Unknown config command: ${subcommand}`);
  console.log(usage());
  return 1;
}
