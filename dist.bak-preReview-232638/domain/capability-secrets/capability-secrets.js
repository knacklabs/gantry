const ENV_NAME_PATTERN = /^[A-Z_][A-Z0-9_]{0,127}$/;
export function normalizeCapabilitySecretName(name) {
    return name.trim().toUpperCase();
}
export function assertValidCapabilitySecretName(name) {
    if (!ENV_NAME_PATTERN.test(name)) {
        throw new Error('Secret name must be an environment variable name using A-Z, 0-9, and underscore, and must start with A-Z or underscore.');
    }
}
export function redactCapabilitySecretValue(_value) {
    return '<redacted>';
}
