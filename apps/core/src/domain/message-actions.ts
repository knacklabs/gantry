export type MessageActionAffordanceKind =
  | 'scheduler_run_now'
  | 'scheduler_pause_job'
  | 'live_turn_stop'
  | 'memory_review_decision';

export type MemoryReviewActionDecision = 'approve' | 'reject' | 'edit';

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
    };

export type MemoryReviewMessageActionInput = Extract<
  MessageActionCallbackInput,
  { kind: 'memory_review_decision' }
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
}

export type OnMessageAction = (
  input: MessageActionCallbackInput,
) => Promise<MessageActionOutcome | void>;

export type OnMemoryReviewMessageAction = (
  input: MemoryReviewMessageActionInput,
) => Promise<MessageActionOutcome>;
