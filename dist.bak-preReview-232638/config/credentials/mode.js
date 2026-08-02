export function parseHostCredentialMode(raw) {
    const normalized = raw?.trim().toLowerCase();
    if (normalized === 'none')
        return 'none';
    if (normalized === 'gantry')
        return 'gantry';
    return undefined;
}
export function resolveHostCredentialMode(rawMode) {
    const parsed = parseHostCredentialMode(rawMode);
    if (parsed)
        return parsed;
    return 'gantry';
}
