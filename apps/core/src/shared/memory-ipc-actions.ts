export const MEMORY_IPC_ACTIONS_BY_TOOL_NAME = {
  memory_search: 'memory_search',
  memory_save: 'memory_save',
  memory_patch: 'memory_patch',
  memory_consolidate: 'memory_consolidate',
  memory_dream: 'memory_dream',
  memory_review_pending: 'memory_review_pending',
  memory_review_decision: 'memory_review_decision',
  procedure_save: 'procedure_save',
  procedure_patch: 'procedure_patch',
} as const;

export type MyClawMemoryIpcAction =
  (typeof MEMORY_IPC_ACTIONS_BY_TOOL_NAME)[keyof typeof MEMORY_IPC_ACTIONS_BY_TOOL_NAME];

const MEMORY_IPC_ACTION_ORDER = [
  'memory_search',
  'memory_save',
  'memory_patch',
  'memory_consolidate',
  'memory_dream',
  'memory_review_pending',
  'memory_review_decision',
  'procedure_save',
  'procedure_patch',
] as const satisfies readonly MyClawMemoryIpcAction[];

const MEMORY_IPC_ACTION_SET = new Set<string>(MEMORY_IPC_ACTION_ORDER);
const DEFAULT_MEMORY_IPC_ACTIONS = [
  'memory_search',
  'memory_save',
  'procedure_save',
] as const satisfies readonly MyClawMemoryIpcAction[];

export function normalizeMemoryIpcActions(
  actions: readonly string[] | undefined,
): MyClawMemoryIpcAction[] {
  if (!actions) return [];
  const selected = new Set(
    actions
      .map((action) => action.trim())
      .filter((action): action is MyClawMemoryIpcAction =>
        MEMORY_IPC_ACTION_SET.has(action),
      ),
  );
  return MEMORY_IPC_ACTION_ORDER.filter((action) => selected.has(action));
}

export function memoryIpcActionForToolName(
  toolName: string,
): MyClawMemoryIpcAction | undefined {
  return toolName in MEMORY_IPC_ACTIONS_BY_TOOL_NAME
    ? MEMORY_IPC_ACTIONS_BY_TOOL_NAME[
        toolName as keyof typeof MEMORY_IPC_ACTIONS_BY_TOOL_NAME
      ]
    : undefined;
}

export function selectedMemoryIpcActionsFromToolRules(
  configuredTools: readonly string[],
): MyClawMemoryIpcAction[] {
  const actions: MyClawMemoryIpcAction[] = [...DEFAULT_MEMORY_IPC_ACTIONS];
  for (const rule of configuredTools) {
    const trimmed = rule.trim();
    if (!trimmed.startsWith('mcp__myclaw__')) continue;
    const toolName = trimmed.slice('mcp__myclaw__'.length);
    const action = memoryIpcActionForToolName(toolName);
    if (action) actions.push(action);
  }
  return normalizeMemoryIpcActions(actions);
}
