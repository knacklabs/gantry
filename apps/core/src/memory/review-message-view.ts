import type { MemoryReviewActionDecision } from '../domain/types.js';
import type {
  MemoryReviewRecord,
  MemoryReviewSnapshot,
  MemoryReviewSnapshotEvidence,
} from './memory-types.js';

/**
 * Provider-neutral view model for a memory-review message. Slack, Telegram and
 * Teams each map this to native blocks; nothing here is provider-specific. Every
 * field is sourced from the review's IMMUTABLE snapshot (Task 3), never live
 * rows, so the message a reviewer sees never drifts from what was flagged.
 *
 * Layout is the locked "compact structured" shape:
 *   <title>
 *   Topic: <topic>
 *   • <side.label>: "<value>" — <source> · <date>   (one per side)
 *   Change → <change>
 *   Why: <why>
 *   [evidence — collapsible, bounded]
 *   [Approve] [Reject] [Edit]
 */
export interface ReviewMessageView {
  reviewId: string;
  kind: 'contradiction' | 'retire' | 'rewrite' | 'merge';
  title: string;
  topic: string;
  sides: ReviewMessageSide[];
  change: string;
  why: string;
  evidence: ReviewMessageEvidence[];
  affordances: ReviewMessageAffordance[];
}

export interface ReviewMessageSide {
  label: string;
  value: string;
  source?: string;
  date?: string;
}

export interface ReviewMessageEvidence {
  source: string;
  snippet: string;
  date?: string;
  uri?: string;
}

export interface ReviewMessageAffordance {
  label: string;
  decision: MemoryReviewActionDecision;
  reviewId: string;
}

const MAX_VALUE_LENGTH = 140;
const MAX_EVIDENCE = 3;
const MAX_EVIDENCE_SNIPPET = 160;

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

const TITLE_BY_KIND: Record<ReviewMessageView['kind'], string> = {
  contradiction: '🧠 Memory review · conflicting note',
  retire: '🧠 Memory review · retire note',
  rewrite: '🧠 Memory review · update note',
  merge: '🧠 Memory review · merge notes',
};

function truncate(value: string | undefined, max: number): string {
  const clean = (value ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1)}…`;
}

/**
 * Human date from an ISO capturedAt, locale-independent so the rendered message
 * is deterministic across environments (e.g. "Jul 24, 2026").
 * ponytail: fixed month-name formatter; swap for Intl only if localization lands.
 */
function humanDate(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

/** Newest evidence row for a role, so a side's "source · date" reflects recency. */
function representativeEvidence(
  snapshot: MemoryReviewSnapshot,
  role: 'active' | 'incoming',
): MemoryReviewSnapshotEvidence | undefined {
  return snapshot.evidence
    .filter((item) => item.role === role)
    .sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1))[0];
}

function sideFromEvidence(
  label: string,
  value: string,
  evidence: MemoryReviewSnapshotEvidence | undefined,
): ReviewMessageSide {
  const date = humanDate(evidence?.capturedAt);
  return {
    label,
    value: truncate(value, MAX_VALUE_LENGTH),
    ...(evidence?.sourceType ? { source: evidence.sourceType } : {}),
    ...(date ? { date } : {}),
  };
}

function classifyKind(record: MemoryReviewRecord): ReviewMessageView['kind'] {
  const action = record.proposal.action;
  if (action === 'merge') return 'merge';
  if (action === 'retire') return 'retire';
  if (record.reviewSnapshot?.conflict?.incoming) return 'contradiction';
  return 'rewrite';
}

function boundedEvidence(
  snapshot: MemoryReviewSnapshot,
): ReviewMessageEvidence[] {
  return snapshot.evidence.slice(0, MAX_EVIDENCE).map((item) => ({
    source: item.sourceType,
    snippet: truncate(item.text, MAX_EVIDENCE_SNIPPET),
    ...(humanDate(item.capturedAt) ? { date: humanDate(item.capturedAt) } : {}),
    ...(item.sourceUri ? { uri: item.sourceUri } : {}),
  }));
}

/**
 * Build the compact-structured view for ONE review from its frozen snapshot.
 * Reviews without a snapshot (legacy) render a minimal fallback rather than
 * re-reading mutable rows — snapshot is the only content source.
 */
export function buildReviewMessageView(
  record: MemoryReviewRecord,
): ReviewMessageView {
  const kind = classifyKind(record);
  const snapshot = record.reviewSnapshot ?? undefined;
  const active = snapshot?.conflict?.active;
  const incoming = snapshot?.conflict?.incoming;
  const proposed = snapshot?.proposedCanonical;

  const topic =
    active?.key ?? proposed?.key ?? record.proposal.key ?? record.id;
  const why = truncate(
    proposed?.reason || record.proposal.reason,
    MAX_VALUE_LENGTH,
  );

  const sides: ReviewMessageSide[] = [];
  let change = '';

  if (kind === 'contradiction') {
    sides.push(
      sideFromEvidence(
        'Now',
        active?.value ?? '',
        snapshot ? representativeEvidence(snapshot, 'active') : undefined,
      ),
    );
    sides.push(
      sideFromEvidence(
        'New',
        incoming?.value ?? '',
        snapshot ? representativeEvidence(snapshot, 'incoming') : undefined,
      ),
    );
    change = `"${truncate(proposed?.value, MAX_VALUE_LENGTH)}"`;
  } else if (kind === 'rewrite') {
    sides.push(
      sideFromEvidence(
        'Now',
        active?.value ?? '',
        snapshot ? representativeEvidence(snapshot, 'active') : undefined,
      ),
    );
    change = `"${truncate(proposed?.value, MAX_VALUE_LENGTH)}"`;
  } else if (kind === 'retire') {
    sides.push(
      sideFromEvidence(
        'Now',
        active?.value ?? '',
        snapshot ? representativeEvidence(snapshot, 'active') : undefined,
      ),
    );
    change = 'remove this note';
  } else {
    // merge: target survives; retiring[] disappears. Evidence is role 'active'
    // for all participants and isn't keyed per-item, so participant lines carry
    // the value only; the collapsible evidence keeps source · date.
    const rep = snapshot
      ? representativeEvidence(snapshot, 'active')
      : undefined;
    sides.push(sideFromEvidence('Keep', active?.value ?? '', rep));
    for (const participant of snapshot?.retiring ?? []) {
      sides.push({
        label: 'Merge',
        value: truncate(participant.value, MAX_VALUE_LENGTH),
      });
    }
    const targetLabel = active?.key ?? topic;
    change = `merge ${(snapshot?.retiring ?? []).length + 1} notes into "${targetLabel}"`;
  }

  return {
    reviewId: record.id,
    kind,
    title: TITLE_BY_KIND[kind],
    topic,
    sides,
    change,
    why,
    evidence: snapshot ? boundedEvidence(snapshot) : [],
    affordances: [
      { label: 'Approve', decision: 'approve', reviewId: record.id },
      { label: 'Reject', decision: 'reject', reviewId: record.id },
      { label: 'Edit', decision: 'edit', reviewId: record.id },
    ],
  };
}
