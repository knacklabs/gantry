import { normalizeRuntimeSecretRefString } from '../../domain/ports/runtime-secret-provider.js';
import type {
  RuntimeProviderAccountSettings,
  RuntimeProviderSettings,
} from './runtime-settings-types.js';
import {
  containsControlCharacter,
  parseStringValue,
} from './runtime-settings-parse-primitives.js';

export function parseProviderAccounts(
  raw: unknown,
  providers: Record<string, RuntimeProviderSettings>,
  agents: Record<string, { name: string }>,
): Record<string, RuntimeProviderAccountSettings> {
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('provider_accounts must be a mapping');
  }
  const accounts: Record<string, RuntimeProviderAccountSettings> = {};
  const seenIdentityRefs = new Set<string>();
  for (const [accountId, accountRaw] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    const pathPrefix = `provider_accounts.${accountId}`;
    if (accountId.trim().length === 0 || containsControlCharacter(accountId)) {
      throw new Error(`${pathPrefix} must use a stable provider account id`);
    }
    if (
      typeof accountRaw !== 'object' ||
      accountRaw === null ||
      Array.isArray(accountRaw)
    ) {
      throw new Error(`${pathPrefix} must be a mapping`);
    }
    const map = accountRaw as Record<string, unknown>;
    for (const key of Object.keys(map)) {
      if (
        key !== 'agent' &&
        key !== 'agent_id' &&
        key !== 'provider' &&
        key !== 'label' &&
        key !== 'status' &&
        key !== 'runtime_secret_refs' &&
        key !== 'external_identity_ref' &&
        key !== 'config'
      ) {
        throw new Error(
          `${pathPrefix}.${key} is not supported. Configure agent, provider, label, status, runtime_secret_refs, external_identity_ref, or config.`,
        );
      }
    }
    const agentId = parseStringValue(
      map.agent_id ?? map.agent,
      `${pathPrefix}.agent`,
    );
    if (!agents[agentId]) {
      throw new Error(
        `${pathPrefix}.agent references unknown agent ${agentId}`,
      );
    }
    const provider = parseStringValue(map.provider, `${pathPrefix}.provider`);
    if (!providers[provider]) {
      throw new Error(
        `${pathPrefix}.provider references unknown provider ${provider}`,
      );
    }
    const runtimeSecretRefs = parseRuntimeSecretRefs(
      map.runtime_secret_refs,
      pathPrefix,
    );
    const externalIdentityRef = parseOptionalStringMap(
      map.external_identity_ref,
      `${pathPrefix}.external_identity_ref`,
    );
    const status = parseStringValue(
      map.status,
      `${pathPrefix}.status`,
      'active',
    );
    if (status !== 'active' && status !== 'disabled') {
      throw new Error(`${pathPrefix}.status must be active or disabled`);
    }
    const identityKey =
      Object.keys(externalIdentityRef).length > 0
        ? `${provider}:${JSON.stringify(
            Object.entries(externalIdentityRef).sort(([a], [b]) =>
              a.localeCompare(b),
            ),
          )}`
        : undefined;
    if (
      status === 'active' &&
      identityKey &&
      seenIdentityRefs.has(identityKey)
    ) {
      throw new Error(
        `${pathPrefix}.external_identity_ref duplicates another provider account`,
      );
    }
    if (status === 'active' && identityKey) seenIdentityRefs.add(identityKey);
    accounts[accountId] = {
      agentId,
      provider,
      label: parseStringValue(map.label, `${pathPrefix}.label`, accountId),
      ...(status === 'disabled' ? { status } : {}),
      runtimeSecretRefs,
      ...(Object.keys(externalIdentityRef).length > 0
        ? { externalIdentityRef }
        : {}),
      config: parseOptionalStringMap(map.config, `${pathPrefix}.config`),
    };
  }

  return accounts;
}

function parseRuntimeSecretRefs(
  raw: unknown,
  pathPrefix: string,
): Record<string, string> {
  const refsRaw = raw ?? {};
  if (
    typeof refsRaw !== 'object' ||
    refsRaw === null ||
    Array.isArray(refsRaw)
  ) {
    throw new Error(`${pathPrefix}.runtime_secret_refs must be a mapping`);
  }
  const runtimeSecretRefs: Record<string, string> = {};
  for (const [key, value] of Object.entries(
    refsRaw as Record<string, unknown>,
  )) {
    if (!/^[A-Za-z_][A-Za-z0-9_:-]{0,63}$/.test(key)) {
      throw new Error(
        `${pathPrefix}.runtime_secret_refs.${key} is not a valid key`,
      );
    }
    runtimeSecretRefs[key] = normalizeRuntimeSecretRefString(
      parseStringValue(value, `${pathPrefix}.runtime_secret_refs.${key}`),
      `${pathPrefix}.runtime_secret_refs.${key}`,
    );
  }
  return runtimeSecretRefs;
}

function parseOptionalStringMap(
  raw: unknown,
  pathPrefix: string,
): Record<string, string> {
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${pathPrefix} must be a mapping`);
  }
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).map(([key, value]) => [
      key,
      parseStringValue(value, `${pathPrefix}.${key}`),
    ]),
  );
}
