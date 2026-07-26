import type {
  MemoryReviewRecord,
  MemoryReviewSnapshot,
  MemoryReviewSnapshotEvidence,
} from './memory-types.js';
import {
  morePendingReviewsLabel,
  type ReviewMessageView,
  type ReviewMessageSide,
  type ReviewMessageEvidence,
} from '../domain/review-message-view.js';

// The provider-neutral view types + the pure `morePendingReviewsLabel` helper
// live in the domain layer so channel adapters can render them without an
// adapters→runtime import. This module keeps the snapshot-driven builder and
// the text fallback, which need the runtime memory types, and re-exports the
// domain view types so existing runtime importers keep their import path.
export type {
  ReviewMessageView,
  ReviewMessageSide,
  ReviewMessageEvidence,
  ReviewMessageAffordance,
} from '../domain/review-message-view.js';
export { morePendingReviewsLabel } from '../domain/review-message-view.js';

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

function sideText(side: ReviewMessageSide): string {
  const meta = [side.source, side.date].filter(Boolean).join(' · ');
  const value = `${side.label}: "${side.value}"`;
  return meta ? `${value} — ${meta}` : value;
}

/**
 * Plain-text rendering of a review for channels/surfaces without native buttons
 * (the in-app channel, unsupported providers). Same compact-structured content
 * as the native cards, plus an explicit reply-command line so a reviewer can
 * still act — no fake button metadata, just the documented text path.
 */
export function reviewMessageFallbackText(view: ReviewMessageView): string {
  const lines = [
    view.title,
    `Topic: ${view.topic}`,
    ...view.sides.map(sideText),
    `Change → ${view.change}`,
    `Why: ${view.why}`,
  ];
  for (const item of view.evidence) {
    const meta = [item.source, item.date].filter(Boolean).join(' · ');
    lines.push(`📎 ${meta ? `${meta}: ` : ''}${item.snippet}`);
  }
  const morePending = morePendingReviewsLabel(view);
  if (morePending) lines.push(`${morePending}.`);
  lines.push(
    `Reply "approve ${view.reviewId}" or "reject ${view.reviewId}", ` +
      `or "edit memory review ${view.reviewId}: <replacement> — <reason>".`,
  );
  return lines.join('\n');
}
