export const PATTERN_ACTION_KIND_TOOL = {
    scheduler_job: 'scheduler_upsert_job',
    durable_capability: 'request_access',
    skill: 'request_skill_proposal',
    memory_update: 'memory_save',
};
const PATTERN_ACTION_KINDS = new Set(Object.keys(PATTERN_ACTION_KIND_TOOL));
export function isPatternActionKind(value) {
    return (typeof value === 'string' &&
        PATTERN_ACTION_KINDS.has(value));
}
