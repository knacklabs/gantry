import { inspectRuntimeSecretReadiness } from '../adapters/storage/postgres/storage-readiness.js';
import { normalizeRuntimeSecretRefString, parseRuntimeSecretRefString, } from '../domain/ports/runtime-secret-provider.js';
export async function collectUnresolvedRuntimeSecretProviderIds(runtimeHome, settings) {
    try {
        const readiness = await inspectRuntimeSecretReadiness(runtimeHome, settings);
        return unresolvedProviderIdsFromRuntimeSecretDetails(readiness.status === 'fail' ? (readiness.details ?? []) : []);
    }
    catch {
        return providersWithStorageBackedRuntimeSecretRefs(settings);
    }
}
export function unresolvedProviderIdsFromRuntimeSecretDetails(details) {
    const providerIds = new Set();
    for (const detail of details) {
        const match = /^provider_accounts\.[^.]+\.provider ([^. ]+)/.exec(detail) ??
            /^providers\.([^.]+)\./.exec(detail);
        if (match)
            providerIds.add(match[1]);
    }
    return providerIds;
}
export function isMissingRuntimeCredential(input) {
    const refSource = runtimeSecretRefSource(input.rawRef);
    if (refSource === 'env') {
        const envName = runtimeSecretEnvName(input.rawRef) ?? input.envKey;
        return !input.env[envName]?.trim();
    }
    if (refSource === 'stored') {
        return input.unresolvedRuntimeSecretProviderIds.has(input.providerId);
    }
    return !input.env[input.envKey]?.trim();
}
function providersWithStorageBackedRuntimeSecretRefs(settings) {
    const providerIds = new Set();
    for (const account of Object.values(settings.providerAccounts)) {
        if (!account)
            continue;
        if (!settings.providers[account.provider]?.enabled)
            continue;
        for (const rawRef of Object.values(account.runtimeSecretRefs)) {
            if (runtimeSecretRefSource(rawRef) === 'stored') {
                providerIds.add(account.provider);
            }
        }
    }
    return providerIds;
}
function runtimeSecretRefSource(rawRef) {
    if (!rawRef?.trim())
        return null;
    try {
        const normalized = normalizeRuntimeSecretRefString(rawRef);
        return parseRuntimeSecretRefString(normalized).source === 'env'
            ? 'env'
            : 'stored';
    }
    catch {
        return 'stored';
    }
}
function runtimeSecretEnvName(rawRef) {
    if (!rawRef?.trim())
        return null;
    try {
        const normalized = normalizeRuntimeSecretRefString(rawRef);
        const parsed = parseRuntimeSecretRefString(normalized);
        return parsed.source === 'env' ? parsed.name : null;
    }
    catch {
        return null;
    }
}
