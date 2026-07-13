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
} as const;

export type GantryMemoryIpcAction =
  (typeof MEMORY_IPC_ACTIONS_BY_TOOL_NAME)[keyof typeof MEMORY_IPC_ACTIONS_BY_TOOL_NAME];

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
] as const satisfies readonly GantryMemoryIpcAction[];

const MEMORY_IPC_ACTION_SET = new Set<string>(MEMORY_IPC_ACTION_ORDER);
const DEFAULT_MEMORY_IPC_ACTIONS = [
  'memory_search',
  'memory_save',
  'brain_search',
  'brain_query',
  'brain_write',
  'continuity_summary',
  'procedure_save',
] as const satisfies readonly GantryMemoryIpcAction[];

const REVIEWER_MEMORY_REVIEW_IPC_ACTIONS = [
  'memory_review_pending',
  'memory_review_decision',
] as const satisfies readonly GantryMemoryIpcAction[];
const AUTHORITY_CHANGING_MEMORY_TOOL_NAMES = new Set<string>([
  'memory_patch',
  'memory_demote',
  'continuity_summary_patch',
  'memory_consolidate',
  'memory_dream',
  'memory_review_pending',
  'memory_review_decision',
  'procedure_patch',
]);

export function normalizeMemoryIpcActions(
  actions: readonly string[] | undefined,
): GantryMemoryIpcAction[] {
  if (!actions) return [];
  const selected = new Set(
    actions
      .map((action) => action.trim())
      .filter((action): action is GantryMemoryIpcAction =>
        MEMORY_IPC_ACTION_SET.has(action),
      ),
  );
  return MEMORY_IPC_ACTION_ORDER.filter((action) => selected.has(action));
}

export function memoryIpcActionForToolName(
  toolName: string,
): GantryMemoryIpcAction | undefined {
  return toolName in MEMORY_IPC_ACTIONS_BY_TOOL_NAME
    ? MEMORY_IPC_ACTIONS_BY_TOOL_NAME[
        toolName as keyof typeof MEMORY_IPC_ACTIONS_BY_TOOL_NAME
      ]
    : undefined;
}

export interface MemoryIpcActionSelectionOptions {
  memoryReviewerIsControlApprover?: boolean;
  excludeAuthorityTools?: boolean;
}

export function selectedMemoryIpcActionsFromToolRules(
  configuredTools: readonly string[],
  options: MemoryIpcActionSelectionOptions = {},
): GantryMemoryIpcAction[] {
  const actions: GantryMemoryIpcAction[] = [...DEFAULT_MEMORY_IPC_ACTIONS];
  if (
    options.memoryReviewerIsControlApprover &&
    !options.excludeAuthorityTools
  ) {
    actions.push(...REVIEWER_MEMORY_REVIEW_IPC_ACTIONS);
  }
  for (const rule of configuredTools) {
    const trimmed = rule.trim();
    if (!trimmed.startsWith('mcp__gantry__')) continue;
    const toolName = trimmed.slice('mcp__gantry__'.length);
    if (
      options.excludeAuthorityTools &&
      AUTHORITY_CHANGING_MEMORY_TOOL_NAMES.has(toolName)
    ) {
      continue;
    }
    const action = memoryIpcActionForToolName(toolName);
    if (action) actions.push(action);
  }
  return normalizeMemoryIpcActions(actions);
}
