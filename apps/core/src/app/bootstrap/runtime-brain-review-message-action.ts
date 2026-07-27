import type { BrainDreamReviewDecisionResult } from '../../brain/brain-dream-review-executor.js';
import type {
  BrainDreamReviewMessageActionInput,
  MessageActionOutcome,
} from '../../domain/types.js';

/**
 * Execute a channel-initiated brain-dream destructive-review decision.
 *
 * OWNER-ONLY (like the observer digest handler, and stricter than memory
 * review's same-channel approver): brain changes are app-wide and delete SHARED
 * knowledge, so a channel-local approver must NOT gain that authority. The
 * channel supplies an AUTHENTICATED provider identity + conversation; it never
 * supplies authority. This handler:
 *   1. requires a provider-authenticated userId,
 *   2. resolves the CURRENT verified owner route and requires the callback
 *      userId + conversation + providerAccountId to match it EXACTLY, and
 *   3. only then hands the decision to the trusted executor
 *      (executeBrainDreamReviewDecision); the at-most-once / drift / terminal
 *      vetoes all live in that DB path, not here.
 * Unlike the observer handler this does NOT depend on Observer being enabled —
 * the verified-owner resolver is injected and works with Observer off.
 */

export interface BrainReviewVerifiedOwner {
  owner?: {
    recipient: string;
    conversationJid: string;
    providerAccountId: string;
  };
}

export interface BrainReviewMessageActionDeps {
  appId: string;
  // The CURRENT DB-verified owner route; an unverified/unconfigured owner yields
  // a value WITHOUT `owner`. Injected so this handler never imports config.
  resolveVerifiedOwner: () => Promise<BrainReviewVerifiedOwner>;
  // Bound to { db, reviews } by the wiring; runs the T3 drift-safe executor.
  executeDecision: (input: {
    appId: string;
    reviewId: string;
    decision: 'approve' | 'reject';
    reviewer: {
      userId: string;
      conversationJid: string;
      providerAccountId: string;
    };
  }) => Promise<BrainDreamReviewDecisionResult>;
  warn: (context: Record<string, unknown>, message: string) => void;
}

const OWNER_ONLY_RECEIPT =
  'Only the brain owner can approve or reject these changes.';
const NOT_FOUND_RECEIPT = 'This proposal could not be found.';
const APPLYING_RECEIPT = 'This proposal is already being applied.';
const FAILED_RECEIPT = 'This change could not be applied.';
const TRANSIENT_RECEIPT = "Couldn't process this, please try again.";

export async function handleBrainDreamReviewAction(
  deps: BrainReviewMessageActionDeps,
  action: BrainDreamReviewMessageActionInput,
): Promise<MessageActionOutcome> {
  // Step 1: a provider-authenticated user is required — identity in, never authority.
  if (!action.userId) {
    return {
      state: 'invalid',
      receipt: 'Missing an authenticated user for this action.',
    };
  }
  try {
    // Step 2: the callback identity + route MUST be the current verified owner.
    const owner = (await deps.resolveVerifiedOwner()).owner;
    if (
      !owner ||
      action.userId !== owner.recipient ||
      action.conversationJid !== owner.conversationJid ||
      (action.providerAccountId ?? '') !== owner.providerAccountId
    ) {
      return { state: 'denied', receipt: OWNER_ONLY_RECEIPT };
    }
    // Step 3: hand the decision to the trusted drift-safe executor.
    const result = await deps.executeDecision({
      appId: deps.appId,
      reviewId: action.reviewId,
      decision: action.decision,
      reviewer: {
        userId: owner.recipient,
        conversationJid: owner.conversationJid,
        providerAccountId: owner.providerAccountId,
      },
    });
    return mapOutcome(result);
  } catch (err) {
    deps.warn(
      {
        reviewId: action.reviewId,
        error: err instanceof Error ? err.message : String(err),
      },
      'brain review action failed inside the owner boundary',
    );
    // A thrown/transient error (e.g. a DB blip) may fire BEFORE any decision is
    // recorded — the review is still pending_review. A terminal 'invalid' would
    // make every adapter replace the shared card and strip the buttons, so a
    // momentary failure would permanently disable the owner. Return the SAME
    // non-terminal shape as denied/applying: a private note to the clicker, the
    // shared card + buttons untouched, so a retry is still possible. DURABLE
    // failures (failed/not_found from the executor) stay terminal in mapOutcome.
    return { state: 'denied', receipt: TRANSIENT_RECEIPT };
  }
}

// Map the executor's durable outcome to a channel outcome. Terminal states
// (applied/rejected/stale/failed/not_found) settle the shared card and clear
// the buttons; a lost race (applying) is a private note to the clicker and
// leaves the shared card untouched.
function mapOutcome(
  result: BrainDreamReviewDecisionResult,
): MessageActionOutcome {
  switch (result.outcome) {
    case 'applied':
      return {
        state: 'applied',
        receipt: '✅ Applied — the change is live.',
        clearActions: true,
      };
    case 'rejected':
      return {
        state: 'applied',
        receipt: '🚫 Rejected — nothing was changed.',
        clearActions: true,
      };
    case 'stale':
      return {
        state: 'stale',
        receipt:
          '⚠️ Skipped — the page or graph changed since this was proposed.',
        clearActions: true,
      };
    case 'failed':
      return { state: 'invalid', receipt: FAILED_RECEIPT, clearActions: true };
    case 'applying':
      // Lost the at-most-once race; the winning click settles the card. Both
      // approve AND reject report the same applying receipt — a reject clicker
      // seeing "could not be found" for a proposal that IS being applied is
      // false and confusing for a destructive change.
      return { state: 'denied', receipt: APPLYING_RECEIPT };
    case 'not_found':
      return {
        state: 'invalid',
        receipt: NOT_FOUND_RECEIPT,
        clearActions: true,
      };
    default:
      // 'pending_review' or any unexpected state: never mutated, treat as stale.
      return { state: 'invalid', receipt: NOT_FOUND_RECEIPT };
  }
}
