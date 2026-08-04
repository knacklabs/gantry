export const DELEGATED_TASK_CONTEXT_RESULT_LIMIT = 4_000;
export const DELEGATED_TASK_LIST_PREVIEW_LIMIT = 1_000;

export function boundDelegatedTaskContextResult(
  value: string,
  taskId: string,
): string {
  if (value.length <= DELEGATED_TASK_CONTEXT_RESULT_LIMIT) return value;
  const suffix =
    `\n\n[Result truncated for context safety. ` +
    `Use task_get with taskId ${taskId} for the full result.]`;
  return `${value.slice(
    0,
    Math.max(0, DELEGATED_TASK_CONTEXT_RESULT_LIMIT - suffix.length),
  )}${suffix}`;
}
