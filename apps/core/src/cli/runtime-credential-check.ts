import {
  normalizeRuntimeSecretRefString,
  parseRuntimeSecretRefString,
} from '../domain/ports/runtime-secret-provider.js';
import { runtimeSecretKeyForEnv } from '../domain/provider/provider-runtime-secret-keys.js';

export function resolveRuntimeEnvValue(
  env: Record<string, string>,
  key: string,
): string {
  return env[key]?.trim() || process.env[key]?.trim() || '';
}

interface RuntimeCredentialSettings {
  providerAccounts: Record<
    string,
    | {
        provider: string;
        status?: 'active' | 'disabled';
        runtimeSecretRefs: Record<string, string | undefined>;
      }
    | undefined
  >;
}

function hasRuntimeSecretRefConfigured(
  ref: string | undefined,
  env: Record<string, string>,
): boolean {
  const value = ref?.trim();
  if (!value) return false;
  try {
    const parsed = parseRuntimeSecretRefString(
      normalizeRuntimeSecretRefString(value),
    );
    return parsed.source === 'env'
      ? Boolean(resolveRuntimeEnvValue(env, parsed.name))
      : true;
  } catch {
    return false;
  }
}

function runtimeSecretRefSource(
  ref: string | undefined,
): 'env' | 'stored' | null {
  const value = ref?.trim();
  if (!value) return null;
  try {
    const parsed = parseRuntimeSecretRefString(
      normalizeRuntimeSecretRefString(value),
    );
    return parsed.source === 'env' ? 'env' : 'stored';
  } catch {
    return null;
  }
}

export function hasRuntimeCredentialConfigured(input: {
  settings?: RuntimeCredentialSettings;
  env: Record<string, string>;
  providerId: string;
  envKey: string;
  unresolvedRuntimeSecretProviderIds?: Set<string>;
}): boolean {
  const refKey = runtimeSecretKeyForEnv(input.providerId, input.envKey);
  let hasConfiguredAccountRef = false;
  let hasProviderAccount = false;
  for (const account of Object.values(input.settings?.providerAccounts ?? {})) {
    if (!account || account.provider !== input.providerId) continue;
    if (account.status === 'disabled') continue;
    hasProviderAccount = true;
    const rawRef = account.runtimeSecretRefs[refKey];
    if (
      input.unresolvedRuntimeSecretProviderIds?.has(input.providerId) &&
      runtimeSecretRefSource(rawRef) === 'stored'
    ) {
      continue;
    }
    if (hasRuntimeSecretRefConfigured(rawRef, input.env)) {
      hasConfiguredAccountRef = true;
      break;
    }
  }
  return hasProviderAccount && hasConfiguredAccountRef;
}
