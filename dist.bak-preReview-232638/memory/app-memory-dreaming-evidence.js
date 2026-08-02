export function parseJsonArray(value) {
    if (!value)
        return [];
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed)
            ? parsed.filter((entry) => typeof entry === 'string')
            : [];
    }
    catch {
        return [];
    }
}
export function parseJsonObject(value) {
    if (!value)
        return {};
    if (typeof value === 'object' && !Array.isArray(value)) {
        return value;
    }
    if (typeof value !== 'string')
        return {};
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? parsed
            : {};
    }
    catch {
        return {};
    }
}
export function isUnsafeEvidence(evidence) {
    const metadata = parseJsonObject(evidence.metadataJson);
    return (metadata.unsafeSource === true ||
        metadata.quarantined === true ||
        metadata.promptInjection === true ||
        metadata.safety === 'unsafe' ||
        metadata.safety === 'quarantined');
}
