export const RELATIONSHIP_MODES = ['personal', 'organization'];
export const DEFAULT_RELATIONSHIP_MODE = 'personal';
export function resolveAgentRelationshipMode(value) {
    if (typeof value !== 'string')
        return DEFAULT_RELATIONSHIP_MODE;
    const normalized = value
        .trim()
        .toLowerCase()
        .replace(/[-\s]+/g, '_');
    return RELATIONSHIP_MODES.includes(normalized)
        ? normalized
        : DEFAULT_RELATIONSHIP_MODE;
}
export function parseAgentRelationshipMode(value, path) {
    if (value === undefined)
        return DEFAULT_RELATIONSHIP_MODE;
    if (typeof value !== 'string') {
        throw new Error(`${path} must be one of ${RELATIONSHIP_MODES.join(', ')}`);
    }
    const normalized = value
        .trim()
        .toLowerCase()
        .replace(/[-\s]+/g, '_');
    if (!RELATIONSHIP_MODES.includes(normalized)) {
        throw new Error(`${path} must be one of ${RELATIONSHIP_MODES.join(', ')}`);
    }
    return normalized;
}
