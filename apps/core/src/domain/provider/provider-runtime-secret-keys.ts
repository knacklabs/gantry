import {
  normalizeRuntimeSecretRefString,
  parseRuntimeSecretRefString,
} from '../ports/runtime-secret-provider.js';
import { createHash } from 'node:crypto';

/**
 * Produces a stable, provider-account-scoped name for a runtime credential.
 * The digest prevents two account ids that normalize to the same readable
 * component from silently sharing a secret.
 */
export function runtimeSecretNameForProviderAccount(
  providerId: string,
  providerAccountId: string,
  key: string,
): string {
  const provider = providerEnvPrefix(providerId);
  const account =
    providerAccountId
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 72) || 'DEFAULT';
  const suffix = key
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const digest = createHash('sha256')
    .update(`${providerId}\u0000${providerAccountId}\u0000${key}`)
    .digest('hex')
    .slice(0, 10)
    .toUpperCase();
  return `${provider}_${account}_${digest}_${suffix}`.slice(0, 128);
}

export function slackRuntimeSecretNameForAgent(
  agentName: string,
  key: 'BOT_TOKEN' | 'APP_TOKEN',
): string {
  const normalized = agentName
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!normalized) {
    throw new Error('A non-empty Slack agent name is required for credential naming.');
  }
  return `${normalized}_SLACK_${key}`;
}

export function runtimeSecretKeyForEnv(
  providerId: string,
  envKey: string,
): string {
  const canonical = envKey.trim().toUpperCase();
  return canonical
    .replace(new RegExp(`^${providerEnvPrefix(providerId)}_`), '')
    .toLowerCase();
}

export function expectedRuntimeSecretEnvForKey(
  providerId: string,
  key: string,
): string | undefined {
  const normalizedKey = key.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(normalizedKey)) return undefined;
  return `${providerEnvPrefix(providerId)}_${normalizedKey}`;
}

export function isProviderRuntimeSecretRefTarget(
  providerId: string,
  key: string,
  ref: string,
): boolean {
  const expectedEnv = expectedRuntimeSecretEnvForKey(providerId, key);
  if (!expectedEnv) return false;
  const parsed = parseRuntimeSecretRefString(
    normalizeRuntimeSecretRefString(ref),
  );
  if (parsed.source === 'aws-sm') return true;
  return isProviderScopedSecretName(providerId, key, parsed.name, expectedEnv);
}

function providerEnvPrefix(providerId: string): string {
  return providerId
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .toUpperCase();
}

function isProviderScopedSecretName(
  providerId: string,
  key: string,
  name: string,
  expectedEnv: string,
): boolean {
  if (name === expectedEnv) return true;
  const providerPrefix = escapeRegExp(providerEnvPrefix(providerId));
  const normalizedKey = key.trim().toUpperCase();
  return (
    new RegExp(`(^|_)${providerPrefix}_`).test(name) &&
    name.endsWith(`_${normalizedKey}`)
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
