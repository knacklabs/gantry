import type {
  PatternCandidateStatus,
  PatternProposalStatus,
} from '@gantry/contracts';

/**
 * Internal constants for the pattern-candidate loop. v1 deliberately ships no
 * `settings.yaml` surface for these; they become configurable only after the
 * detection gate (Phase 0) proves value.
 */
export const PATTERN_DETECTION_WINDOW_DAYS = 30;
export const PATTERN_DETECTION_MIN_OCCURRENCES = 3;
export const PATTERN_NGRAM_MIN = 2;
export const PATTERN_NGRAM_MAX = 3;
export const PATTERN_MAX_CANDIDATES_PER_RUN = 20;
export const PATTERN_SNOOZE_DAYS = 14;
export const PATTERN_INTENSIFY_DELTA = 3;
// recurrence floor; add friction scoring when the detector emits it
export const PATTERN_VALUE_FLOOR_MIN_OCCURRENCES = 4;
export const PATTERN_VALUE_FLOOR_MIN_SPAN_DAYS = 2;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The live user choices offered when a candidate is surfaced. */
export type PatternCandidateChoice = 'create_draft' | 'not_now' | 'dismiss';

/** Candidate statuses the runner may surface live. */
export const SURFACEABLE_STATUSES: PatternCandidateStatus[] = [
  'detected',
  'suggested',
];
export const PATTERN_SUGGESTED_FOLLOWUP_HOURS = 24;

export function isSurfaceable(status: PatternCandidateStatus): boolean {
  return SURFACEABLE_STATUSES.includes(status);
}

export function snoozeUntil(nowIso: string): string {
  return new Date(
    new Date(nowIso).getTime() + PATTERN_SNOOZE_DAYS * DAY_MS,
  ).toISOString();
}

export function meetsRecurrenceValueFloor(input: {
  occurrences: number;
  windowStart: string;
  windowEnd: string;
}): boolean {
  const spanDays = Math.floor(
    (new Date(input.windowEnd).getTime() -
      new Date(input.windowStart).getTime()) /
      DAY_MS,
  );
  return (
    input.occurrences >= PATTERN_VALUE_FLOOR_MIN_OCCURRENCES &&
    spanDays >= PATTERN_VALUE_FLOOR_MIN_SPAN_DAYS
  );
}

/**
 * Map a live user choice to the candidate status it writes.
 * `create_draft` is the ONLY choice that later starts `request_skill_proposal`;
 * the proposal outcome is tracked separately via {@link PatternProposalStatus}.
 */
export function candidateStatusForChoice(
  choice: PatternCandidateChoice,
): PatternCandidateStatus {
  switch (choice) {
    case 'create_draft':
      return 'accepted';
    case 'not_now':
      return 'snoozed';
    case 'dismiss':
      return 'dismissed';
  }
}

/** The proposal status written the moment a `create_draft` choice fires. */
export function initialProposalStatus(): PatternProposalStatus {
  return 'proposal_requested';
}

/**
 * On re-detection of an existing candidate, decide whether a snoozed candidate
 * becomes eligible again: its snooze elapsed, or it intensified (occurrences up
 * by >= PATTERN_INTENSIFY_DELTA within the window). Never resurrects a
 * `dismissed` or `accepted` candidate.
 */
export function shouldResetSnooze(input: {
  status: PatternCandidateStatus;
  snoozedUntil: string | null;
  previousOccurrences: number;
  newOccurrences: number;
  nowIso: string;
}): boolean {
  if (input.status !== 'snoozed') return false;
  const elapsed =
    input.snoozedUntil !== null &&
    new Date(input.snoozedUntil).getTime() <= new Date(input.nowIso).getTime();
  const intensified =
    input.newOccurrences - input.previousOccurrences >= PATTERN_INTENSIFY_DELTA;
  return elapsed || intensified;
}
