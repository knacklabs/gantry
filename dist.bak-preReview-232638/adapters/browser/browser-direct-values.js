export function browserClickModifiers(value) {
    const allowed = new Set(['Alt', 'Control', 'Meta', 'Shift']);
    if (!Array.isArray(value))
        return [];
    return value.filter((item) => typeof item === 'string' && allowed.has(item));
}
export function stringRecord(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return {};
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
        if (typeof entry === 'string')
            out[key] = entry;
    }
    return out;
}
