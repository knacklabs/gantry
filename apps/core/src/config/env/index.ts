import path from 'path';

import { readEnvFile } from './file.js';
import { getGantryHome } from '../../shared/gantry-home.js';

export const CONFIG_ENV_KEYS = [
  'GANTRY_HOME',
  'ONECLI_DATABASE_URL',
  'SECRET_ENCRYPTION_KEY',
  'TZ',
  'GANTRY_IPC_AUTH_SECRET',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'LOG_LEVEL',
  'GANTRY_INTERACTIVE_PERMISSION_TIMEOUT_MS',
  'GANTRY_AUTONOMOUS_PERMISSION_TIMEOUT_MS',
  'PERMISSION_APPROVAL_TIMEOUT_MS',
  'GANTRY_PERMISSION_TIMEOUT_MS',
  'TELEGRAM_BOT_TOKEN',
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'INTERAKT_BOT_TOKEN',
  'INTERAKT_WEBHOOK_SECRET',
  'INTERAKT_BUSINESS_PHONE_NUMBER',
  'INTERAKT_BASE_URL',
] as const;

function loadRuntimeEnvConfig(keys: readonly string[]): Record<string, string> {
  const raw = readEnvFile(path.join(getGantryHome(), '.env'));
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = raw[key]?.trim();
    if (value) {
      out[key] = value;
    }
  }
  return out;
}

export const envConfig = loadRuntimeEnvConfig(CONFIG_ENV_KEYS);
const runtimeEnvConfig = readEnvFile(path.join(getGantryHome(), '.env'));

export function envValue(key: (typeof CONFIG_ENV_KEYS)[number]): string {
  return process.env[key]?.trim() || envConfig[key]?.trim() || '';
}

export function runtimeEnvValue(key: (typeof CONFIG_ENV_KEYS)[number]): string {
  return process.env[key]?.trim() || envConfig[key]?.trim() || '';
}

export function envValueDynamic(key: string): string {
  return process.env[key]?.trim() || runtimeEnvConfig[key]?.trim() || '';
}

export function runtimeEnvValueDynamic(key: string): string {
  return process.env[key]?.trim() || runtimeEnvConfig[key]?.trim() || '';
}

/**
 * Copies selected opt-in runtime flags from $GANTRY_HOME/.env into process.env
 * (only when not already set). Lower layers (`shared`, `application`) may not
 * import `config`, so flags read there via process.env are made configurable
 * from .env by hydrating them here at startup. An explicit process.env value
 * (e.g. set on the launch command) always takes precedence.
 */
export function hydrateDynamicRuntimeEnv(keys: readonly string[]): void {
  for (const key of keys) {
    if (process.env[key] !== undefined) continue;
    const value = runtimeEnvConfig[key]?.trim();
    if (value) process.env[key] = value;
  }
}
