export function isSafeExecutionProviderId(value) {
    if (value.startsWith('unconfigured:'))
        return false;
    return /^[A-Za-z0-9][A-Za-z0-9._-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}
export function assertSafeExecutionProviderId(value) {
    if (!isSafeExecutionProviderId(value)) {
        throw new Error(`Invalid execution provider id: ${value}`);
    }
}
