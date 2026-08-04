export const AGENT_PERSONAS = [
    'developer',
    'generalist',
    'sales',
    'marketing',
    'operations',
    'research',
];
export const DEFAULT_AGENT_PERSONA = 'developer';
export const UNKNOWN_AGENT_PERSONA_FALLBACK = 'generalist';
export function resolveAgentPersona(value) {
    if (typeof value !== 'string')
        return DEFAULT_AGENT_PERSONA;
    const normalized = value
        .trim()
        .toLowerCase()
        .replace(/[-\s]+/g, '_');
    return AGENT_PERSONAS.includes(normalized)
        ? normalized
        : UNKNOWN_AGENT_PERSONA_FALLBACK;
}
export function parseAgentPersona(value, path) {
    if (value === undefined)
        return DEFAULT_AGENT_PERSONA;
    if (typeof value !== 'string') {
        throw new Error(`${path} must be one of ${AGENT_PERSONAS.join(', ')}`);
    }
    const normalized = value
        .trim()
        .toLowerCase()
        .replace(/[-\s]+/g, '_');
    if (!AGENT_PERSONAS.includes(normalized)) {
        throw new Error(`${path} must be one of ${AGENT_PERSONAS.join(', ')}`);
    }
    return normalized;
}
