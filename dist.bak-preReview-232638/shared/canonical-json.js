export function canonicalJson(value) {
    return JSON.stringify(canonicalize(value));
}
function canonicalize(value) {
    if (Array.isArray(value)) {
        return value.map((item) => canonicalize(item));
    }
    if (!value || typeof value !== 'object') {
        return value;
    }
    const out = Object.create(null);
    for (const key of Object.keys(value).sort()) {
        const item = value[key];
        if (item !== undefined) {
            Object.defineProperty(out, key, {
                value: canonicalize(item),
                enumerable: true,
                configurable: true,
                writable: true,
            });
        }
    }
    return out;
}
