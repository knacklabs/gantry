import type {
  MessageActionCallbackInput,
  MessageActionOutcome,
  OnBrainDreamReviewMessageAction,
  OnMemoryReviewMessageAction,
  OnMessageAction,
  OnObserverFeedbackMessageAction,
  ProgressUpdateOptions,
} from '../../domain/types.js';

const OBSERVER_FEEDBACK_ACTIONS = new Set([
  'resolve',
  'dismiss',
  'snooze',
  'less_like_this',
]);

function isLiveStopActionTokenValid(
  input: MessageActionCallbackInput,
): boolean {
  if (input.kind !== 'live_turn_stop') return true;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    input.actionToken ?? '',
  );
}

function isMessageActionValid(input: MessageActionCallbackInput): boolean {
  if (
    input.kind === 'scheduler_run_now' ||
    input.kind === 'scheduler_pause_job' ||
    input.kind === 'scheduler_retry_ask'
  ) {
    return input.jobId.trim().length > 0;
  }
  if (input.kind === 'job_permission_decision') {
    return input.actionToken.trim().length > 0;
  }
  if (input.kind === 'memory_review_decision') {
    return (
      input.reviewId.trim().length > 0 &&
      (input.decision === 'approve' ||
        input.decision === 'reject' ||
        input.decision === 'edit')
    );
  }
  if (input.kind === 'observer_feedback') {
    return (
      input.insightId.trim().length > 0 &&
      OBSERVER_FEEDBACK_ACTIONS.has(input.action) &&
      input.localDay.trim().length > 0
    );
  }
  if (input.kind === 'brain_dream_review_decision') {
    return (
      input.reviewId.trim().length > 0 &&
      (input.decision === 'approve' || input.decision === 'reject')
    );
  }
  return isLiveStopActionTokenValid(input);
}

export function createChannelMessageActionRouter(): {
  handle: (
    input: MessageActionCallbackInput,
  ) => Promise<MessageActionOutcome | void>;
  trackProgress: (
    conversationJid: string,
    options?: ProgressUpdateOptions,
  ) => void;
  set: (handler: OnMessageAction | undefined) => void;
  setMemoryReviewHandler: (
    handler: OnMemoryReviewMessageAction | undefined,
  ) => void;
  setObserverFeedbackHandler: (
    handler: OnObserverFeedbackMessageAction | undefined,
  ) => void;
  setBrainDreamReviewHandler: (
    handler: OnBrainDreamReviewMessageAction | undefined,
  ) => void;
} {
  let handler: OnMessageAction | undefined;
  let memoryReviewHandler: OnMemoryReviewMessageAction | undefined;
  // Task 5 sets the owner-only executor here; until then observer_feedback
  // callbacks parse + validate + route but settle to a no-op (void outcome).
  let observerFeedbackHandler: OnObserverFeedbackMessageAction | undefined;
  let brainDreamReviewHandler: OnBrainDreamReviewMessageAction | undefined;
  return {
    handle: async (input: MessageActionCallbackInput) => {
      if (!isMessageActionValid(input)) return;
      if (input.kind === 'memory_review_decision') {
        return memoryReviewHandler?.(input);
      }
      if (input.kind === 'observer_feedback') {
        return observerFeedbackHandler?.(input);
      }
      if (input.kind === 'brain_dream_review_decision') {
        return brainDreamReviewHandler?.(input);
      }
      return handler?.(input);
    },
    trackProgress: () => {},
    set: (next: OnMessageAction | undefined) => {
      handler = next;
    },
    setMemoryReviewHandler: (next: OnMemoryReviewMessageAction | undefined) => {
      memoryReviewHandler = next;
    },
    setObserverFeedbackHandler: (
      next: OnObserverFeedbackMessageAction | undefined,
    ) => {
      observerFeedbackHandler = next;
    },
    setBrainDreamReviewHandler: (
      next: OnBrainDreamReviewMessageAction | undefined,
    ) => {
      brainDreamReviewHandler = next;
    },
  };
}
