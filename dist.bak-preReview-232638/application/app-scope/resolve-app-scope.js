function readAssertedAppId(value) {
    if (typeof value !== 'string')
        return null;
    const assertedAppId = value.trim();
    return assertedAppId ? assertedAppId : null;
}
export function resolveAppScopeAppId(input) {
    const assertedAppId = readAssertedAppId(input.assertedAppId);
    if (!assertedAppId)
        return input.apiKeyAppId;
    return assertedAppId === input.apiKeyAppId ? input.apiKeyAppId : null;
}
