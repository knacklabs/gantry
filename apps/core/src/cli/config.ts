import * as p from '@clack/prompts';

import { readEnvFile, upsertEnvFile } from '../config/env/file.js';
import {
  envFilePath,
  ensureRuntimeLayout,
} from '../config/settings/runtime-home.js';
import {
  classifyConfigKey,
  validateRuntimeEnvPolicy,
} from '../config/source-classification.js';
import {
  loadRuntimeSettings,
  saveRuntimeSettings,
} from '../config/settings/runtime-settings.js';
import { parseHostCredentialMode } from '../config/credentials/mode.js';
import { normalizeClaudeModelSelection } from '../models/claude-model-registry.js';

function usage(): string {
  return [
    'Config commands:',
    '  myclaw config list',
    '  myclaw config get <KEY> [--raw]',
    '  myclaw config set <KEY> <VALUE>',
    '  myclaw config unset <KEY>',
    '  myclaw config migrate-env',
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
    `${key} must not be configured in MyClaw .env.`
  );
}

function isSensitiveKey(key: string): boolean {
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
    p.log.error('Usage: myclaw config get <KEY> [--raw]');
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
    p.log.error('Usage: myclaw config set <KEY> <VALUE>');
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
      'Value cannot be empty. Use `myclaw config unset <KEY>` to remove a key.',
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
    p.log.error('Usage: myclaw config unset <KEY>');
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

function parseIdList(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return [
    ...new Set(
      raw
        .split(/[,\s]+/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    ),
  ];
}

function mergeIdList(existing: string[], incoming: string[]): string[] {
  return [...new Set([...existing, ...incoming])];
}

function runMigrateEnv(runtimeHome: string): number {
  ensureRuntimeLayout(runtimeHome);
  const envPath = envFilePath(runtimeHome);
  const env = readEnvFile(envPath);
  const settings = loadRuntimeSettings(runtimeHome);
  const removals: Record<string, null> = {};
  const migrated: string[] = [];

  if (env.MYCLAW_CREDENTIAL_MODE?.trim()) {
    const parsedMode = parseHostCredentialMode(env.MYCLAW_CREDENTIAL_MODE);
    if (!parsedMode) {
      p.log.error(
        `Invalid MYCLAW_CREDENTIAL_MODE "${env.MYCLAW_CREDENTIAL_MODE}". Expected one of: none, onecli, external. Fix the value before running migrate-env.`,
      );
      return 1;
    }
    settings.credentialBroker.mode = parsedMode;
    removals.MYCLAW_CREDENTIAL_MODE = null;
    migrated.push('MYCLAW_CREDENTIAL_MODE -> credential_broker.mode');
  }
  if (env.ONECLI_URL?.trim()) {
    settings.credentialBroker.onecli.url = env.ONECLI_URL.trim();
    removals.ONECLI_URL = null;
    migrated.push('ONECLI_URL -> credential_broker.onecli.url');
  }
  if (env.ANTHROPIC_BASE_URL?.trim()) {
    settings.credentialBroker.external.baseUrl = env.ANTHROPIC_BASE_URL.trim();
    removals.ANTHROPIC_BASE_URL = null;
    migrated.push('ANTHROPIC_BASE_URL -> credential_broker.external.base_url');
  }
  if (env.ANTHROPIC_MODEL?.trim()) {
    settings.agent.defaultModel =
      normalizeClaudeModelSelection(env.ANTHROPIC_MODEL) ||
      env.ANTHROPIC_MODEL.trim();
    removals.ANTHROPIC_MODEL = null;
    migrated.push('ANTHROPIC_MODEL -> agent.default_model');
  }
  if (env.SLACK_PERMISSION_APPROVER_IDS?.trim()) {
    if (settings.channels.slack) {
      settings.channels.slack.controlAllowlist.default = mergeIdList(
        settings.channels.slack.controlAllowlist.default,
        parseIdList(env.SLACK_PERMISSION_APPROVER_IDS),
      );
    }
    removals.SLACK_PERMISSION_APPROVER_IDS = null;
    migrated.push(
      'SLACK_PERMISSION_APPROVER_IDS -> channels.slack.control_allowlist.default',
    );
  }

  for (const [key, value] of Object.entries(env)) {
    const classified = classifyConfigKey(key);
    if (classified?.lane === 'agent-credential' && value.trim()) {
      removals[key] = null;
      migrated.push(`${key} removed; configure it in the credential broker`);
    }
  }

  const envAfterMigration: Partial<Record<string, string | undefined>> = {
    ...env,
  };
  for (const key of Object.keys(removals)) {
    envAfterMigration[key] = undefined;
  }
  const remainingViolations =
    validateRuntimeEnvPolicy(envAfterMigration).violations;
  const unmigratedSettings = remainingViolations.filter(
    (violation) => violation.lane === 'non-secret-setting',
  );
  if (unmigratedSettings.length > 0) {
    p.log.error(
      [
        'migrate-env cannot automatically migrate these settings-owned keys:',
        ...unmigratedSettings.map(
          (violation) => `${violation.key} -> ${violation.destination}`,
        ),
        'Move them to settings.yaml or remove them from .env, then rerun doctor.',
      ].join('\n'),
    );
    return 1;
  }

  if (migrated.length === 0) {
    p.log.success('No wrong-lane .env keys found to migrate.');
    return 0;
  }

  saveRuntimeSettings(runtimeHome, settings);
  upsertEnvFile(envPath, removals);
  p.log.success(
    `Migrated ${migrated.length} .env entr${migrated.length === 1 ? 'y' : 'ies'}.`,
  );
  for (const entry of migrated) p.log.info(entry);
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
  if (subcommand === 'migrate-env') {
    return runMigrateEnv(runtimeHome);
  }

  p.log.error(`Unknown config command: ${subcommand}`);
  console.log(usage());
  return 1;
}
