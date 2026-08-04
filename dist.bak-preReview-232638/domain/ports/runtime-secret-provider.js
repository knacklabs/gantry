const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/;
export function envRuntimeSecretRef(name) {
    const normalized = normalizeRuntimeEnvName(name);
    return `env:${normalized}`;
}
export function gantryRuntimeSecretRef(name) {
    const normalized = normalizeRuntimeEnvName(name);
    return `gantry-secret:${normalized}`;
}
export function awsSecretsManagerRuntimeSecretRef(name) {
    const parsed = parseRuntimeSecretRefString(`aws-sm:${name}`);
    return `aws-sm:${parsed.name}`;
}
export function parseRuntimeSecretRefString(value, path = 'runtime secret ref') {
    const trimmed = value.trim();
    const separator = trimmed.indexOf(':');
    if (separator <= 0) {
        throw new Error(`${path} must use env:<VAR>, gantry-secret:<id>, or aws-sm:<name-or-arn>.`);
    }
    const source = trimmed.slice(0, separator);
    const name = trimmed.slice(separator + 1).trim();
    if (source === 'env' || source === 'gantry-secret') {
        return { source, name: normalizeRuntimeEnvName(name, path) };
    }
    if (source === 'aws-sm') {
        if (!name || /[\r\n]/.test(name)) {
            throw new Error(`${path} has an invalid AWS Secrets Manager ref.`);
        }
        return { source, name };
    }
    throw new Error(`${path} must use env:<VAR>, gantry-secret:<id>, or aws-sm:<name-or-arn>.`);
}
export function normalizeRuntimeSecretRefString(value, path = 'runtime secret ref') {
    const trimmed = value.trim();
    if (ENV_NAME_PATTERN.test(trimmed))
        return envRuntimeSecretRef(trimmed);
    const parsed = parseRuntimeSecretRefString(trimmed, path);
    return `${parsed.source}:${parsed.name}`;
}
export function runtimeSecretRefTarget(ref) {
    if (ref.ref !== undefined)
        return parseRuntimeSecretRefString(ref.ref);
    if (ref.env !== undefined) {
        const trimmed = ref.env.trim();
        return trimmed.includes(':')
            ? parseRuntimeSecretRefString(trimmed)
            : { source: 'env', name: normalizeRuntimeEnvName(trimmed) };
    }
    throw new Error('Runtime secret ref is required.');
}
export function isForbiddenRuntimeSecretEnvName(key) {
    const normalized = key.trim().toUpperCase();
    return (normalized.includes('API_KEY') ||
        normalized.includes('OAUTH_TOKEN') ||
        normalized.endsWith('_AUTH_TOKEN'));
}
export async function getOptionalRuntimeSecret(provider, ref) {
    if (!provider)
        return undefined;
    const asyncValue = await provider.getOptionalSecretAsync?.(ref);
    if (asyncValue)
        return asyncValue;
    const value = provider.getOptionalSecret(ref);
    if (value)
        return value;
    const target = runtimeSecretRefTarget(ref);
    return target.source === 'env'
        ? provider.getOptionalSecret({ env: target.name })
        : undefined;
}
function normalizeRuntimeEnvName(value, path = 'runtime secret ref') {
    const normalized = value.trim().toUpperCase();
    if (!ENV_NAME_PATTERN.test(normalized)) {
        throw new Error(`${path} must use an environment-style name with A-Z, 0-9, and underscore.`);
    }
    return normalized;
}
