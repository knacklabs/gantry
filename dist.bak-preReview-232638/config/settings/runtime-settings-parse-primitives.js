export function parseStringArrayValue(raw, pathPrefix, fallback, validateItem) {
    if (raw === undefined && fallback !== undefined)
        return fallback;
    if (!Array.isArray(raw)) {
        throw new Error(`${pathPrefix} must be a string array`);
    }
    return [
        ...new Set(raw.map((item, index) => {
            if (typeof item !== 'string' || item.trim().length === 0) {
                throw new Error(`${pathPrefix}[${index}] must be a non-empty string`);
            }
            const value = item.trim();
            try {
                return validateItem?.(value) ?? value;
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                throw new Error(`${pathPrefix}[${index}] ${message}`, {
                    cause: err,
                });
            }
        })),
    ];
}
export function parseOptionalStringValue(raw, pathPrefix) {
    if (raw === undefined)
        return undefined;
    return parseStringValue(raw, pathPrefix);
}
export function parseStringValue(raw, pathPrefix, fallback) {
    if (raw === undefined && fallback !== undefined)
        return fallback;
    if (typeof raw !== 'string' || raw.trim().length === 0) {
        throw new Error(`${pathPrefix} must be a non-empty string`);
    }
    return raw.trim();
}
export function parseBooleanValue(raw, pathPrefix, fallback) {
    if (raw === undefined && fallback !== undefined)
        return fallback;
    if (typeof raw !== 'boolean') {
        throw new Error(`${pathPrefix} must be true/false`);
    }
    return raw;
}
export function parsePositiveIntegerValue(raw, pathPrefix, fallback) {
    if (raw === undefined)
        return fallback;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
        throw new Error(`${pathPrefix} must be a positive integer`);
    }
    return raw;
}
export function parseNonNegativeIntegerValue(raw, pathPrefix, fallback) {
    if (raw === undefined)
        return fallback;
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
        throw new Error(`${pathPrefix} must be a non-negative integer`);
    }
    return raw;
}
export function containsControlCharacter(value) {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code <= 31 || code === 127)
            return true;
    }
    return false;
}
