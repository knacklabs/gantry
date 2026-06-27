/**
 * The agent chooses this kind outcome-first in conversation after the user's
 * affirmative. The batch detector does not classify it. Accepting only marks
 * the candidate accepted and records which reviewed flow handles the durable
 * fix; the candidate's literal text is never executed.
 */
export type PatternActionKind =
  | 'scheduler_job'
  | 'durable_capability'
  | 'skill'
  | 'memory_update';

export const PATTERN_ACTION_KIND_TOOL: Record<PatternActionKind, string> = {
  scheduler_job: 'scheduler_upsert_job',
  durable_capability: 'request_access',
  skill: 'request_skill_proposal',
  memory_update: 'memory_save',
};

const PATTERN_ACTION_KINDS = new Set<PatternActionKind>(
  Object.keys(PATTERN_ACTION_KIND_TOOL) as PatternActionKind[],
);

export function isPatternActionKind(
  value: unknown,
): value is PatternActionKind {
  return (
    typeof value === 'string' &&
    PATTERN_ACTION_KINDS.has(value as PatternActionKind)
  );
}
