import path from 'path';

import { readEnvFile } from './file.js';
import { getGantryHome } from '../../shared/gantry-home.js';

export const CONFIG_ENV_KEYS = [
  'GANTRY_HOME',
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
  'DISCORD_BOT_TOKEN',
  'DISCORD_APPLICATION_ID',
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
