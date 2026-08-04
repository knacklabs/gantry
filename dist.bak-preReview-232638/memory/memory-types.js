export const MEMORY_GLOBAL_WORKSPACE_FOLDER = '_global';
export const DIRECT_SAVE_MEMORY_KINDS = [
    'preference',
    'decision',
    'fact',
    'correction',
    'constraint',
];
export function isDirectSaveMemoryKind(value) {
    return (typeof value === 'string' &&
        DIRECT_SAVE_MEMORY_KINDS.includes(value));
}
