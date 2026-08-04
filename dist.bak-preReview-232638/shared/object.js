export function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function toTrimmedString(value, opts = {}) {
    if (typeof value !== 'string')
        return undefined;
    const trimmed = value.trim();
    if (!opts.allowEmpty && trimmed.length === 0)
        return undefined;
    if (opts.maxLen && trimmed.length > opts.maxLen)
        return undefined;
    return trimmed;
}
