// Persistence port for the company-brain destructive-proposal review lifecycle
// (Phase 3). T1 is the foundation: create a review + its target claims in one
// txn, read pending reviews, and drive the at-most-once claim state machine.
// No brain mutation happens here — executors (T3/T4) ride claimTransition.

export type BrainDreamReviewState =
  | 'pending_review'
  | 'applying'
  | 'applied'
  | 'rejected'
  | 'stale'
  | 'failed';

export type BrainDreamReviewTargetKind = 'page' | 'entity' | 'edge';

export interface BrainDreamReviewTargetInput {
  targetKind: BrainDreamReviewTargetKind;
  targetId: string;
  // The version/hash the snapshot was captured against, for T3/T4 drift checks.
  // Nullable because the brain page/entity/edge tables carry no dedicated
  // version column today (see repo note) — callers pass updated_at or a hash.
  expectedVersion?: string | null;
}

export interface BrainDreamReviewCreateInput {
  id: string;
  appId: string;
  runId?: string | null;
  decisionId: string;
  action: string;
  canonicalOp: Record<string, unknown>;
  reviewSnapshot: Record<string, unknown>;
  reviewerUserId?: string | null;
  reviewerConversationJid?: string | null;
  reviewerProviderAccountId?: string | null;
  nowIso: string;
  targets: BrainDreamReviewTargetInput[];
}

export interface BrainDreamReview {
  id: string;
  appId: string;
  runId: string | null;
  decisionId: string;
  action: string;
  canonicalOp: Record<string, unknown>;
  reviewSnapshot: Record<string, unknown>;
  state: BrainDreamReviewState;
  reviewerUserId: string | null;
  reviewerConversationJid: string | null;
  reviewerProviderAccountId: string | null;
  createdAt: string;
  decidedAt: string | null;
  outcome: string | null;
  error: string | null;
}

// Typed, non-throwing create result. A `target_open` conflict means another
// pending review already owns one of the targets; `decision_exists` means a
// review row already exists for this decision. T2 journals rejected/skips on
// either instead of crashing the dream run.
export type BrainDreamReviewCreateResult =
  | { ok: true; review: BrainDreamReview }
  | { ok: false; conflict: 'target_open' | 'decision_exists' };

export interface BrainDreamReviewClaimInput {
  reviewId: string;
  from: BrainDreamReviewState;
  to: BrainDreamReviewState;
  nowIso: string;
  decidedAt?: string | null;
  reviewerUserId?: string | null;
  outcome?: string | null;
  error?: string | null;
}

export interface BrainDreamReviewRepository {
  createBrainDreamReview(
    input: BrainDreamReviewCreateInput,
  ): Promise<BrainDreamReviewCreateResult>;
  findPendingBrainDreamReview(input: {
    appId: string;
    reviewId: string;
  }): Promise<BrainDreamReview | null>;
  listPendingBrainDreamReviews(input: {
    appId: string;
    limit: number;
  }): Promise<BrainDreamReview[]>;
  claimBrainDreamReviewTransition(
    input: BrainDreamReviewClaimInput,
  ): Promise<{ claimed: boolean }>;
}

const TERMINAL_STATES: ReadonlySet<BrainDreamReviewState> = new Set([
  'applied',
  'rejected',
  'stale',
  'failed',
]);

export function isTerminalBrainDreamReviewState(
  state: BrainDreamReviewState,
): boolean {
  return TERMINAL_STATES.has(state);
}
