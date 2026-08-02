export const MEMORY_IPC_ACTIONS_BY_TOOL_NAME = {
    memory_search: 'memory_search',
    memory_save: 'memory_save',
    brain_search: 'brain_search',
    brain_query: 'brain_query',
    brain_write: 'brain_write',
    memory_patch: 'memory_patch',
    memory_demote: 'memory_demote',
    continuity_summary: 'continuity_summary',
    memory_consolidate: 'memory_consolidate',
    memory_dream: 'memory_dream',
    memory_review_pending: 'memory_review_pending',
    memory_review_decision: 'memory_review_decision',
    procedure_save: 'procedure_save',
    procedure_patch: 'procedure_patch',
};
const MEMORY_IPC_ACTION_ORDER = [
    'memory_search',
    'memory_save',
    'brain_search',
    'brain_query',
    'brain_write',
    'memory_patch',
    'memory_demote',
    'continuity_summary',
    'memory_consolidate',
    'memory_dream',
    'memory_review_pending',
    'memory_review_decision',
    'procedure_save',
    'procedure_patch',
];
const MEMORY_IPC_ACTION_SET = new Set(MEMORY_IPC_ACTION_ORDER);
const DEFAULT_MEMORY_IPC_ACTIONS = [
    'memory_search',
    'memory_save',
    'brain_search',
    'brain_query',
    'brain_write',
    'continuity_summary',
    'procedure_save',
];
const REVIEWER_MEMORY_REVIEW_IPC_ACTIONS = [
    'memory_review_pending',
    'memory_review_decision',
];
export function normalizeMemoryIpcActions(actions) {
    if (!actions)
        return [];
    const selected = new Set(actions
        .map((action) => action.trim())
        .filter((action) => MEMORY_IPC_ACTION_SET.has(action)));
    return MEMORY_IPC_ACTION_ORDER.filter((action) => selected.has(action));
}
export function memoryIpcActionForToolName(toolName) {
    return toolName in MEMORY_IPC_ACTIONS_BY_TOOL_NAME
        ? MEMORY_IPC_ACTIONS_BY_TOOL_NAME[toolName]
        : undefined;
}
export function selectedMemoryIpcActionsFromToolRules(configuredTools, options = {}) {
    const actions = [...DEFAULT_MEMORY_IPC_ACTIONS];
    if (options.memoryReviewerIsControlApprover) {
        actions.push(...REVIEWER_MEMORY_REVIEW_IPC_ACTIONS);
    }
    for (const rule of configuredTools) {
        const trimmed = rule.trim();
        if (!trimmed.startsWith('mcp__gantry__'))
            continue;
        const toolName = trimmed.slice('mcp__gantry__'.length);
        const action = memoryIpcActionForToolName(toolName);
        if (action)
            actions.push(action);
    }
    return normalizeMemoryIpcActions(actions);
}
