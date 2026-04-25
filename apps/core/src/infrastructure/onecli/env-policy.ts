import { ONECLI_ALLOWED_ENV_KEYS } from '../../config/index.js';

const ONECLI_ALLOWED_ENV_KEY_SET = new Set<string>(ONECLI_ALLOWED_ENV_KEYS);

export const ONECLI_FORBIDDEN_SECRET_ENV_KEYS = new Set([
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'OPENAI_API_KEY',
  'OPENAI_ORG_ID',
  'OPENAI_PROJECT',
  'DATABASE_URL',
  'MYCLAW_DATABASE_URL',
  'ONECLI_DATABASE_URL',
  'SECRET_ENCRYPTION_KEY',
  'POSTGRES_PASSWORD',
  'PGPASSWORD',
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  'MYCLAW_WEBHOOK_SECRET',
]);

const FORBIDDEN_SECRET_ENV_KEY_PATTERN =
  /(^|_)(API_?KEY|AUTH_?TOKEN|TOKEN|SECRET|PASSWORD|PASS|DATABASE_URL|DB_URL|WEBHOOK_SECRET|PRIVATE_?KEY|ACCESS_?KEY|PROXY|CA_CERT|CERT_FILE|EXTRA_CA_CERTS)($|_)/i;

const ONECLI_BROKER_PROXY_ENV_KEYS = new Set([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'NODE_USE_ENV_PROXY',
  'GIT_TERMINAL_PROMPT',
  'GIT_HTTP_PROXY_AUTHMETHOD',
]);

const ONECLI_DROPPED_HOST_CA_KEYS = new Set([
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
]);

function normalizeAllowedBrokerProxyValue(
  key: string,
  value: string,
): string | null {
  if (
    key !== 'HTTP_PROXY' &&
    key !== 'HTTPS_PROXY' &&
    key !== 'http_proxy' &&
    key !== 'https_proxy'
  ) {
    return null;
  }
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== 'http:' ||
      parsed.port !== '10255' ||
      parsed.username !== 'x' ||
      !parsed.password.startsWith('aoc_')
    ) {
      return null;
    }
    if (
      parsed.hostname !== 'host.docker.internal' &&
      parsed.hostname !== '127.0.0.1' &&
      parsed.hostname !== 'localhost'
    ) {
      return null;
    }
    parsed.hostname = '127.0.0.1';
    return parsed.toString();
  } catch {
    return null;
  }
}

export interface OnecliEnvFilterResult {
  env: Record<string, string>;
  droppedKeys: string[];
}

export function filterTrustedOnecliEnv(
  source: Record<string, unknown> | undefined,
): OnecliEnvFilterResult {
  const env: Record<string, string> = {};
  const droppedKeys: string[] = [];
  for (const [key, value] of Object.entries(source || {})) {
    if (ONECLI_DROPPED_HOST_CA_KEYS.has(key)) {
      droppedKeys.push(key);
      continue;
    }
    if (key === 'ANTHROPIC_API_KEY') {
      if (value === 'placeholder') {
        env[key] = value;
        continue;
      }
      throw new Error(
        `OneCLI returned forbidden raw credential env key: ${key}`,
      );
    }
    if (key === 'CLAUDE_CODE_OAUTH_TOKEN') {
      if (value === 'placeholder') {
        env[key] = value;
        continue;
      }
      throw new Error(
        `OneCLI returned forbidden raw credential env key: ${key}`,
      );
    }
    if (ONECLI_BROKER_PROXY_ENV_KEYS.has(key)) {
      if (
        typeof value === 'string' &&
        key === 'NODE_USE_ENV_PROXY' &&
        value === '1'
      ) {
        env[key] = value;
        continue;
      }
      if (
        typeof value === 'string' &&
        key === 'GIT_TERMINAL_PROMPT' &&
        value === '0'
      ) {
        env[key] = value;
        continue;
      }
      if (
        typeof value === 'string' &&
        key === 'GIT_HTTP_PROXY_AUTHMETHOD' &&
        value === 'basic'
      ) {
        env[key] = value;
        continue;
      }
      if (typeof value === 'string') {
        const normalized = normalizeAllowedBrokerProxyValue(key, value);
        if (normalized) {
          env[key] = normalized;
          continue;
        }
      }
      throw new Error(
        `OneCLI returned forbidden raw credential env key: ${key}`,
      );
    }
    if (
      ONECLI_FORBIDDEN_SECRET_ENV_KEYS.has(key) ||
      FORBIDDEN_SECRET_ENV_KEY_PATTERN.test(key)
    ) {
      throw new Error(
        `OneCLI returned forbidden raw credential env key: ${key}`,
      );
    }
    if (
      !ONECLI_ALLOWED_ENV_KEY_SET.has(key) ||
      typeof value !== 'string' ||
      value.length === 0
    ) {
      droppedKeys.push(key);
      continue;
    }
    env[key] = value;
  }
  return { env, droppedKeys };
}
