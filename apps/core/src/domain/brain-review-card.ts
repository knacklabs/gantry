import type { BrainDreamReviewActionDecision } from './message-actions.js';

// Channel-agnostic, COMPACT "what will change" summary built from a review's
// immutable review_snapshot_json (T2). Produces RAW text — each channel applies
// its own escaper (mrkdwn / HTML / card) and size limits. Defensive: a
// malformed/partial snapshot degrades to a generic line, never throws.

export interface BrainReviewCardButton {
  label: string;
  decision: BrainDreamReviewActionDecision;
}

export interface BrainReviewCardView {
  reviewId: string;
  action: string;
  // One-line scannable headline (with a leading glyph).
  headline: string;
  // Optional extra detail lines (e.g. rewrite before→after).
  details: string[];
  buttons: BrainReviewCardButton[];
}

const APPROVE_REJECT: BrainReviewCardButton[] = [
  { label: 'Approve', decision: 'approve' },
  { label: 'Reject', decision: 'reject' },
];

export function renderBrainReviewCard(input: {
  reviewId: string;
  action: string;
  snapshot: Record<string, unknown>;
}): BrainReviewCardView {
  const s = input.snapshot;
  const base = {
    reviewId: input.reviewId,
    action: input.action,
    buttons: APPROVE_REJECT,
  };
  switch (input.action) {
    case 'delete_page': {
      const before = asRecord(s.before);
      const dep = asRecord(s.dependents);
      const edges = asArray(dep.edges).length;
      const embeddings = num(dep.embeddings);
      return {
        ...base,
        headline: `🗑 Delete page «${title(before)}» — also removes ${count(edges, 'evidence link')} + ${count(embeddings, 'embedding')}`,
        details: [],
      };
    }
    case 'rewrite_page': {
      const before = asRecord(s.before);
      const after = asRecord(s.after);
      return {
        ...base,
        headline: `✏️ Rewrite page «${title(before)}»`,
        details: rewriteDetails(before, after),
      };
    }
    case 'delete_entity': {
      const before = asRecord(s.before);
      const edges = asArray(asRecord(s.dependents).edges).length;
      return {
        ...base,
        headline: `🗑 Delete entity «${str(before.name) || '(unknown)'}» — removes ${count(edges, 'relationship')}`,
        details: [],
      };
    }
    case 'delete_edge': {
      const edge = asRecord(s.before);
      const from = str(edge.fromEntityName) || str(edge.fromEntityId) || '?';
      const to = str(edge.toEntityName) || str(edge.toEntityId) || '?';
      return {
        ...base,
        headline: `🗑 Remove relationship: «${from}» —${str(edge.type) || 'related'}→ «${to}»`,
        details: [],
      };
    }
    case 'merge_entities': {
      const source = asRecord(s.source);
      const target = asRecord(s.target);
      const repoint = num(asRecord(s.mergeDelta).edgesToRepoint);
      return {
        ...base,
        headline: `🔀 Merge «${str(source.name) || '(unknown)'}» into «${str(target.name) || '(unknown)'}» — repoints ${count(repoint, 'relationship')}`,
        details: [],
      };
    }
    default:
      return {
        ...base,
        headline: `Review destructive change (${input.action})`,
        details: [],
      };
  }
}

function rewriteDetails(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string[] {
  const lines: string[] = [];
  const beforeTitle = title(before);
  const afterTitle = str(after.title) || beforeTitle;
  if (afterTitle !== beforeTitle) {
    lines.push(`Title: «${beforeTitle}» → «${afterTitle}»`);
  }
  const beforeBody = firstLine(str(before.markdown));
  const afterBody = firstLine(str(after.markdown));
  if (beforeBody || afterBody) {
    lines.push(`Before: ${beforeBody || '(empty)'}`);
    lines.push(`After: ${afterBody || '(empty)'}`);
  }
  return lines;
}

function title(page: Record<string, unknown>): string {
  return str(page.title) || str(page.slug) || '(untitled)';
}

// First non-empty line, code-point-safe truncated to a scannable preview.
function firstLine(markdown: string): string {
  const line = markdown.split('\n').find((l) => l.trim().length > 0) ?? '';
  return truncateCodePoints(line.trim(), 120);
}

function truncateCodePoints(value: string, max: number): string {
  const points = Array.from(value);
  return points.length <= max ? value : `${points.slice(0, max - 1).join('')}…`;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
