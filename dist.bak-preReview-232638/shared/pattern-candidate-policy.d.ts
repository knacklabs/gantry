import type { PatternCandidateStatus, PatternProposalStatus } from '@gantry/contracts';
/**
 * Internal constants for the pattern-candidate loop. v1 deliberately ships no
 * `settings.yaml` surface for these; they become configurable only after the
 * detection gate (Phase 0) proves value.
 */
export declare const PATTERN_DETECTION_WINDOW_DAYS = 30;
export declare const PATTERN_DETECTION_MIN_OCCURRENCES = 3;
export declare const PATTERN_NGRAM_MIN = 2;
export declare const PATTERN_NGRAM_MAX = 3;
export declare const PATTERN_MAX_CANDIDATES_PER_RUN = 20;
export declare const PATTERN_SNOOZE_DAYS = 14;
export declare const PATTERN_INTENSIFY_DELTA = 3;
export declare const PATTERN_VALUE_FLOOR_MIN_OCCURRENCES = 4;
export declare const PATTERN_VALUE_FLOOR_MIN_SPAN_DAYS = 2;
/** The live user choices offered when a candidate is surfaced. */
export type PatternCandidateChoice = 'create_draft' | 'not_now' | 'dismiss';
/** Candidate statuses the runner may surface live. */
export declare const SURFACEABLE_STATUSES: PatternCandidateStatus[];
export declare const PATTERN_SUGGESTED_FOLLOWUP_HOURS = 24;
export declare function isSurfaceable(status: PatternCandidateStatus): boolean;
export declare function snoozeUntil(nowIso: string): string;
export declare function meetsRecurrenceValueFloor(input: {
    occurrences: number;
    windowStart: string;
    windowEnd: string;
}): boolean;
/**
 * Map a live user choice to the candidate status it writes.
 * `create_draft` is the ONLY choice that later starts `request_skill_proposal`;
 * the proposal outcome is tracked separately via {@link PatternProposalStatus}.
 */
export declare function candidateStatusForChoice(choice: PatternCandidateChoice): PatternCandidateStatus;
/** The proposal status written the moment a `create_draft` choice fires. */
export declare function initialProposalStatus(): PatternProposalStatus;
/**
 * On re-detection of an existing candidate, decide whether a snoozed candidate
 * becomes eligible again: its snooze elapsed, or it intensified (occurrences up
 * by >= PATTERN_INTENSIFY_DELTA within the window). Never resurrects a
 * `dismissed` or `accepted` candidate.
 */
export declare function shouldResetSnooze(input: {
    status: PatternCandidateStatus;
    snoozedUntil: string | null;
    previousOccurrences: number;
    newOccurrences: number;
    nowIso: string;
}): boolean;
