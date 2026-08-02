import { normalizeRuntimeSecretRefString, parseRuntimeSecretRefString, } from '../ports/runtime-secret-provider.js';
export function runtimeSecretKeyForEnv(providerId, envKey) {
    const canonical = envKey.trim().toUpperCase();
    return canonical
        .replace(new RegExp(`^${providerEnvPrefix(providerId)}_`), '')
        .toLowerCase();
}
export function expectedRuntimeSecretEnvForKey(providerId, key) {
    const normalizedKey = key.trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(normalizedKey))
        return undefined;
    return `${providerEnvPrefix(providerId)}_${normalizedKey}`;
}
export function isProviderRuntimeSecretRefTarget(providerId, key, ref) {
    const expectedEnv = expectedRuntimeSecretEnvForKey(providerId, key);
    if (!expectedEnv)
        return false;
    const parsed = parseRuntimeSecretRefString(normalizeRuntimeSecretRefString(ref));
    if (parsed.source === 'aws-sm')
        return true;
    return isProviderScopedSecretName(providerId, key, parsed.name, expectedEnv);
}
function providerEnvPrefix(providerId) {
    return providerId
        .trim()
        .replace(/[^a-zA-Z0-9]+/g, '_')
        .toUpperCase();
}
function isProviderScopedSecretName(providerId, key, name, expectedEnv) {
    if (name === expectedEnv)
        return true;
    const providerPrefix = escapeRegExp(providerEnvPrefix(providerId));
    const normalizedKey = key.trim().toUpperCase();
    return (new RegExp(`(^|_)${providerPrefix}_`).test(name) &&
        name.endsWith(`_${normalizedKey}`));
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
