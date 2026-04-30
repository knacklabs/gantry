import { ONECLI_ALLOWED_ENV_KEYS } from '../../../config/index.js';
import {
  CredentialBrokerConfigError,
  CredentialBrokerPolicyError,
} from '../../../domain/models/credential-errors.js';
import { validateOnecliUrl } from './policy.js';

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
const FORBIDDEN_SECRET_QUERY_PARAM_PATTERN =
  /(^|_)(api_?key|auth_?token|token|secret|password|pass|private_?key|access_?key)($|_)/i;
const FORBIDDEN_SECRET_VALUE_PATTERN =
  /(^|[^a-z0-9])(sk-[a-z0-9._-]{12,}|sk-ant-[a-z0-9._-]{8,}|aoc_[a-z0-9_-]+|github_pat_[a-z0-9_]+|gh[pousr]_[a-z0-9_]+|xox[baprs]-[a-z0-9-]+|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|[A-Za-z0-9/+=]{40}|Bearer\s+[a-z0-9._~+/=-]{12,}|eyJ[a-z0-9_-]+\.[a-z0-9_-]+\.[a-z0-9_-]+|-----BEGIN\s+[A-Z ]*PRIVATE KEY-----)([^a-z0-9]|$)/i;

export class OnecliCredentialPolicyError extends CredentialBrokerPolicyError {}
export class OnecliCredentialBrokerConfigError extends CredentialBrokerConfigError {}

function forbiddenKey(key: string): CredentialBrokerPolicyError {
  return new CredentialBrokerPolicyError(
    `OneCLI returned forbidden raw credential env key: ${key}`,
  );
}

function forbiddenValue(key: string): CredentialBrokerPolicyError {
  return new CredentialBrokerPolicyError(
    `OneCLI returned forbidden raw credential env value for key: ${key}`,
  );
}

const ONECLI_MODEL_PROXY_ENV_KEYS = new Set([
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'NODE_USE_ENV_PROXY',
]);

const ONECLI_DROPPED_TOOL_PROXY_ENV_KEYS = new Set([
  'GIT_TERMINAL_PROMPT',
  'GIT_HTTP_PROXY_AUTHMETHOD',
]);

const ONECLI_DROPPED_HOST_CA_KEYS = new Set(['NODE_EXTRA_CA_CERTS']);
const ONECLI_CONTAINER_LOOPBACK_HOST = ['host', 'do' + 'cker', 'internal'].join(
  '.',
);

function validateAllowedOnecliEnvValue(key: string, value: string): string {
  if (FORBIDDEN_SECRET_VALUE_PATTERN.test(value)) {
    throw forbiddenValue(key);
  }
  if (key !== 'ANTHROPIC_BASE_URL') {
    return value;
  }
  let rawParsed: URL;
  try {
    rawParsed = new URL(value);
  } catch {
    throw forbiddenValue(key);
  }
  if (rawParsed.hash || rawParsed.searchParams.size > 0) {
    for (const param of rawParsed.searchParams.keys()) {
      if (FORBIDDEN_SECRET_QUERY_PARAM_PATTERN.test(param)) {
        throw forbiddenValue(key);
      }
    }
    throw forbiddenValue(key);
  }
  const validation = validateOnecliUrl(value);
  if (!validation.ok || !validation.normalizedUrl) {
    throw forbiddenValue(key);
  }
  return validation.normalizedUrl;
}

function validateOnecliModelProxyValue(key: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw forbiddenValue(key);
  }
  if (key === 'NODE_USE_ENV_PROXY') {
    if (value === '1' || value.toLowerCase() === 'true') return value;
    throw forbiddenValue(key);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw forbiddenValue(key);
  }
  const hostname = parsed.hostname.toLowerCase();
  const isLocalProxy =
    hostname === '127.0.0.1' ||
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname === '[::1]' ||
    hostname === ONECLI_CONTAINER_LOOPBACK_HOST;
  const hasOnecliProxyAuth =
    parsed.username === 'x' && /^aoc_[a-f0-9]{64}$/i.test(parsed.password);
  const hasNoProxyAuth = !parsed.username && !parsed.password;
  if (
    parsed.protocol !== 'http:' ||
    !isLocalProxy ||
    (!hasNoProxyAuth && !hasOnecliProxyAuth) ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw forbiddenValue(key);
  }
  if (hostname === ONECLI_CONTAINER_LOOPBACK_HOST) {
    parsed.hostname = '127.0.0.1';
  }
  return parsed.toString();
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
    if (ONECLI_DROPPED_TOOL_PROXY_ENV_KEYS.has(key)) {
      droppedKeys.push(key);
      continue;
    }
    if (ONECLI_MODEL_PROXY_ENV_KEYS.has(key)) {
      env[key] = validateOnecliModelProxyValue(key, value);
      continue;
    }
    if (key === 'ANTHROPIC_API_KEY') {
      if (value === 'placeholder') {
        env[key] = value;
        continue;
      }
      throw forbiddenKey(key);
    }
    if (key === 'CLAUDE_CODE_OAUTH_TOKEN') {
      if (value === 'placeholder') {
        env[key] = value;
        continue;
      }
      throw forbiddenKey(key);
    }
    if (
      ONECLI_FORBIDDEN_SECRET_ENV_KEYS.has(key) ||
      FORBIDDEN_SECRET_ENV_KEY_PATTERN.test(key)
    ) {
      throw forbiddenKey(key);
    }
    if (
      !ONECLI_ALLOWED_ENV_KEY_SET.has(key) ||
      typeof value !== 'string' ||
      value.length === 0
    ) {
      droppedKeys.push(key);
      continue;
    }
    env[key] = validateAllowedOnecliEnvValue(key, value);
  }
  return { env, droppedKeys };
}
