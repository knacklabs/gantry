/**
 * The agent chooses this kind outcome-first in conversation after the user's
 * affirmative. The batch detector does not classify it. Accepting only marks
 * the candidate accepted and records which reviewed flow handles the durable
 * fix; the candidate's literal text is never executed.
 */
export type PatternActionKind = 'scheduler_job' | 'durable_capability' | 'skill' | 'memory_update';
export declare const PATTERN_ACTION_KIND_TOOL: Record<PatternActionKind, string>;
export declare function isPatternActionKind(value: unknown): value is PatternActionKind;
