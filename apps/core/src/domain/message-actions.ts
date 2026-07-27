import type { ObserverDigestMessageView } from './observer-digest-view.js';

export type MessageActionAffordanceKind =
  | 'scheduler_run_now'
  | 'scheduler_pause_job'
  | 'live_turn_stop'
  | 'memory_review_decision'
  | 'observer_feedback'
  | 'brain_dream_review_decision';

export type MemoryReviewActionDecision = 'approve' | 'reject' | 'edit';

export type BrainDreamReviewActionDecision = 'approve' | 'reject';

export type ObserverFeedbackAction =
  | 'resolve'
  | 'dismiss'
  | 'snooze'
  | 'less_like_this';

export type MessageActionAffordance =
  | {
      kind: 'scheduler_run_now' | 'scheduler_pause_job';
      label: string;
      jobId: string;
      runId?: string | null;
    }
  | {
      kind: 'live_turn_stop';
      label: string;
      actionToken: string;
    }
  | {
      kind: 'memory_review_decision';
      label: string;
      reviewId: string;
      decision: MemoryReviewActionDecision;
    }
  | {
      kind: 'observer_feedback';
      label: string;
      insightId: string;
      action: ObserverFeedbackAction;
      // The digest's immutable local day, stamped at render. It rides the
      // callback token so a click self-identifies its EXACT delivery — an insight
      // that rode a later digest too must not resolve against the newer one.
      localDay: string;
    }
  | {
      kind: 'brain_dream_review_decision';
      label: string;
      reviewId: string;
      decision: BrainDreamReviewActionDecision;
    };

export type MessageActionCallbackInput =
  | {
      kind: 'live_turn_stop';
      conversationJid: string;
      providerAccountId?: string;
      threadId?: string;
      userId?: string;
      actionToken?: string;
    }
  | {
      kind: 'scheduler_run_now';
      conversationJid: string;
      providerAccountId?: string;
      threadId?: string;
      userId?: string;
      jobId: string;
      runId?: string | null;
    }
  | {
      kind: 'memory_review_decision';
      conversationJid: string;
      providerAccountId?: string;
      threadId?: string;
      userId?: string;
      reviewId: string;
      decision: MemoryReviewActionDecision;
      label: string;
    }
  | {
      kind: 'observer_feedback';
      conversationJid: string;
      providerAccountId?: string;
      threadId?: string;
      userId: string;
      insightId: string;
      action: ObserverFeedbackAction;
      // Carried from the callback token: the reservation's local day, so the
      // handler loads the EXACT digest this button belongs to (not the newest).
      localDay: string;
    }
  | {
      kind: 'brain_dream_review_decision';
      conversationJid: string;
      providerAccountId?: string;
      threadId?: string;
      userId: string;
      reviewId: string;
      decision: BrainDreamReviewActionDecision;
    };

export type MemoryReviewMessageActionInput = Extract<
  MessageActionCallbackInput,
  { kind: 'memory_review_decision' }
>;

export type ObserverFeedbackMessageActionInput = Extract<
  MessageActionCallbackInput,
  { kind: 'observer_feedback' }
>;

export type BrainDreamReviewMessageActionInput = Extract<
  MessageActionCallbackInput,
  { kind: 'brain_dream_review_decision' }
>;

/**
 * Result a message-action handler returns to the provider adapter so it can
 * render a receipt and decide whether to clear/replace the action buttons.
 * The channel supplies authenticated identity; the host decides authority and
 * reports the settled state here.
 */
export interface MessageActionOutcome {
  state: 'applied' | 'needs_input' | 'denied' | 'stale' | 'invalid';
  receipt: string;
  replacementText?: string;
  clearActions?: boolean;
  /**
   * Digest-only rebuild payload. When an owner action is APPLIED to one insight,
   * the host (Task 5) re-loads the reservation's rendered view, marks the acted
   * insight (buttons removed + state marker) via markObserverDigestInsight, and
   * returns it here so the channel re-renders the WHOLE digest natively —
   * the acted insight settled, the others still fully actionable. Absent for
   * non-terminal outcomes (denied/stale/invalid), which never mutate the digest.
   */
  observerDigestView?: ObserverDigestMessageView;
}

export type OnObserverFeedbackMessageAction = (
  input: ObserverFeedbackMessageActionInput,
) => Promise<MessageActionOutcome | void>;

export type OnBrainDreamReviewMessageAction = (
  input: BrainDreamReviewMessageActionInput,
) => Promise<MessageActionOutcome | void>;

export type OnMessageAction = (
  input: MessageActionCallbackInput,
) => Promise<MessageActionOutcome | void>;

export type OnMemoryReviewMessageAction = (
  input: MemoryReviewMessageActionInput,
) => Promise<MessageActionOutcome>;
