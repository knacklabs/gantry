import { parseJsonObject } from './app-memory-canonical-codec.js';
import type {
  MemoryReviewDisplayPage,
  MemoryReviewEvidenceSnippet,
  MemoryLifecycleProposal,
  MemoryReviewProposedChange,
  MemoryReviewReadableItem,
  MemoryReviewRecord,
  NormalizedMemorySubject,
} from './memory-types.js';

interface MemoryItemValueRow {
  id: string;
  kind: string;
  key: string;
  valueJson: unknown;
}

interface MemoryEvidenceSnippetRow {
  id: string;
  sourceType: string;
  sourceId?: string | null;
  text: string;
  createdAt: string;
}

const DEFAULT_PENDING_REVIEW_LIMIT = 20;
const MAX_PENDING_REVIEW_LIMIT = 50;
const MEMORY_REVIEW_DECISION_OPTIONS = [
  'approve',
  'reject',
  'edit_approve',
] as const;

export function normalizePendingReviewLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_PENDING_REVIEW_LIMIT;
  }
  return Math.max(1, Math.min(MAX_PENDING_REVIEW_LIMIT, Math.trunc(value)));
}

export function normalizePendingReviewOffset(
  value: number | undefined,
): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.trunc(value));
}

function truncateReviewText(
  value: string | undefined,
  maxLength = 180,
): string {
  if (!value) return '';
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength - 1)}…`;
}

export function reviewItemIds(proposal: MemoryLifecycleProposal): string[] {
  return [
    proposal.itemId,
    proposal.targetItemId,
    ...(proposal.itemIds || []),
  ].filter((id): id is string => Boolean(id));
}

export function reviewEvidenceIds(
  reviews: Pick<MemoryReviewRecord, 'proposal'>[],
): string[] {
  return [...new Set(reviews.flatMap((review) => review.proposal.evidenceIds))];
}

export function toReadableReviewItem(
  row: MemoryItemValueRow,
): MemoryReviewReadableItem {
  const value = parseJsonObject(row.valueJson).value;
  return {
    itemId: row.id,
    kind: row.kind,
    key: row.key,
    value: typeof value === 'string' ? value : '',
  };
}

export function toMemoryReviewEvidenceSnippet(
  row: MemoryEvidenceSnippetRow,
): MemoryReviewEvidenceSnippet {
  return {
    evidenceId: row.id,
    sourceType: row.sourceType,
    sourceId: row.sourceId ?? null,
    snippet: truncateReviewText(row.text.replace(/\s+/g, ' '), 240),
    createdAt: row.createdAt,
  };
}

function reviewPageSubject(subject: NormalizedMemorySubject) {
  return {
    appId: subject.appId,
    agentId: subject.agentId,
    subjectType: subject.subjectType,
    subjectId: subject.subjectId,
  };
}

function fallbackItem(
  itemId: string | undefined,
): MemoryReviewReadableItem | null {
  return itemId ? { itemId } : null;
}

function itemLabel(item: MemoryReviewReadableItem | null): string {
  if (!item) return 'memory item';
  if (item.kind && item.key) return `${item.kind}:${item.key}`;
  return item.itemId;
}

function buildMemoryReviewProposedChange(
  proposal: MemoryLifecycleProposal,
  itemsById: Map<string, MemoryReviewReadableItem>,
): MemoryReviewProposedChange {
  const reason = proposal.reason || '';
  const base = {
    action: proposal.action,
    reason,
    confidence: proposal.confidence,
    evidenceIds: proposal.evidenceIds,
  };
  if (proposal.action === 'promote') {
    return {
      ...base,
      summary: `Promote ${proposal.kind || 'memory'}:${proposal.key || 'new item'} from candidate ${proposal.candidateId || 'unknown candidate'}.`,
      after: {
        kind: proposal.kind,
        key: proposal.key,
        value: proposal.value,
      },
    };
  }
  if (proposal.action === 'retire') {
    const before =
      itemsById.get(proposal.itemId || '') || fallbackItem(proposal.itemId);
    return {
      ...base,
      summary: `Retire ${itemLabel(before)}.`,
      before,
      after: null,
    };
  }
  if (proposal.action === 'rewrite' || proposal.action === 'needs_review') {
    const before =
      itemsById.get(proposal.itemId || '') || fallbackItem(proposal.itemId);
    return {
      ...base,
      summary: `Change ${itemLabel(before)} from "${truncateReviewText(before?.value)}" to "${truncateReviewText(proposal.value)}".`,
      before,
      after: {
        kind: proposal.kind || before?.kind,
        key: proposal.key || before?.key,
        value: proposal.value,
      },
    };
  }
  if (proposal.action === 'merge') {
    const target =
      itemsById.get(proposal.targetItemId || '') ||
      fallbackItem(proposal.targetItemId);
    const retiring = (proposal.itemIds || [])
      .filter((id) => id !== proposal.targetItemId)
      .map((id) => itemsById.get(id) || fallbackItem(id))
      .filter((item): item is MemoryReviewReadableItem => Boolean(item));
    return {
      ...base,
      summary: `Merge ${retiring.length} memory item${retiring.length === 1 ? '' : 's'} into ${itemLabel(target)}.`,
      target,
      retiring,
    };
  }
  return {
    ...base,
    summary: `Review ${proposal.action} proposal${proposal.key ? ` for ${proposal.key}` : ''}.`,
    after:
      proposal.kind || proposal.key || proposal.value
        ? {
            kind: proposal.kind,
            key: proposal.key,
            value: proposal.value,
          }
        : null,
  };
}

export function withProposedChanges(
  reviews: MemoryReviewRecord[],
  itemsById: Map<string, MemoryReviewReadableItem>,
): MemoryReviewRecord[] {
  return reviews.map((review) => ({
    ...review,
    proposedChange: buildMemoryReviewProposedChange(review.proposal, itemsById),
  }));
}

export function toMemoryReviewDisplayPage(input: {
  reviews: MemoryReviewRecord[];
  subject: NormalizedMemorySubject;
  totalCount: number;
  returnedCount: number;
  remainingCount: number;
  limit: number;
  offset: number;
  nextOffset: number | null;
  evidenceById?: Map<string, MemoryReviewEvidenceSnippet>;
}): MemoryReviewDisplayPage {
  const evidenceById = input.evidenceById || new Map();
  return {
    items: input.reviews.map((review, index) => {
      const change =
        review.proposedChange ||
        buildMemoryReviewProposedChange(review.proposal, new Map());
      return {
        number: index + 1,
        reviewId: review.id,
        action: change.action,
        summary: change.summary,
        ...(change.before !== undefined ? { before: change.before } : {}),
        ...(change.after !== undefined ? { after: change.after } : {}),
        ...(change.target !== undefined ? { target: change.target } : {}),
        ...(change.retiring !== undefined ? { retiring: change.retiring } : {}),
        reason: change.reason,
        confidence: change.confidence,
        evidenceIds: change.evidenceIds,
        evidence: change.evidenceIds
          .map((id) => evidenceById.get(id))
          .filter((item): item is MemoryReviewEvidenceSnippet => Boolean(item)),
        decisionOptions: [...MEMORY_REVIEW_DECISION_OPTIONS],
      };
    }),
    pageContext: {
      subject: reviewPageSubject(input.subject),
      limit: input.limit,
      offset: input.offset,
      reviewIds: input.reviews.map((review) => review.id),
    },
    totalCount: input.totalCount,
    returnedCount: input.returnedCount,
    remainingCount: input.remainingCount,
    limit: input.limit,
    offset: input.offset,
    nextOffset: input.nextOffset,
  };
}
