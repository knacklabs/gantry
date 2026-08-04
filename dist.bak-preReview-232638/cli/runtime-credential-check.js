import { normalizeRuntimeSecretRefString, parseRuntimeSecretRefString, } from '../domain/ports/runtime-secret-provider.js';
import { runtimeSecretKeyForEnv } from '../domain/provider/provider-runtime-secret-keys.js';
export function resolveRuntimeEnvValue(env, key) {
    return env[key]?.trim() || process.env[key]?.trim() || '';
}
function hasRuntimeSecretRefConfigured(ref, env) {
    const value = ref?.trim();
    if (!value)
        return false;
    try {
        const parsed = parseRuntimeSecretRefString(normalizeRuntimeSecretRefString(value));
        return parsed.source === 'env'
            ? Boolean(resolveRuntimeEnvValue(env, parsed.name))
            : true;
    }
    catch {
        return false;
    }
}
function runtimeSecretRefSource(ref) {
    const value = ref?.trim();
    if (!value)
        return null;
    try {
        const parsed = parseRuntimeSecretRefString(normalizeRuntimeSecretRefString(value));
        return parsed.source === 'env' ? 'env' : 'stored';
    }
    catch {
        return null;
    }
}
export function hasRuntimeCredentialConfigured(input) {
    const refKey = runtimeSecretKeyForEnv(input.providerId, input.envKey);
    let hasConfiguredAccountRef = false;
    let hasProviderAccount = false;
    for (const account of Object.values(input.settings?.providerAccounts ?? {})) {
        if (!account || account.provider !== input.providerId)
            continue;
        if (account.status === 'disabled')
            continue;
        hasProviderAccount = true;
        const rawRef = account.runtimeSecretRefs[refKey];
        if (input.unresolvedRuntimeSecretProviderIds?.has(input.providerId) &&
            runtimeSecretRefSource(rawRef) === 'stored') {
            continue;
        }
        if (hasRuntimeSecretRefConfigured(rawRef, input.env)) {
            hasConfiguredAccountRef = true;
            break;
        }
    }
    return hasProviderAccount && hasConfiguredAccountRef;
}
