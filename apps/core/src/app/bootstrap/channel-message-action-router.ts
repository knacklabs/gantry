import type {
  MessageActionCallbackInput,
  MessageActionOutcome,
  OnMemoryReviewMessageAction,
  OnMessageAction,
  ProgressUpdateOptions,
} from '../../domain/types.js';

function isLiveStopActionTokenValid(
  input: MessageActionCallbackInput,
): boolean {
  if (input.kind !== 'live_turn_stop') return true;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    input.actionToken ?? '',
  );
}

function isMessageActionValid(input: MessageActionCallbackInput): boolean {
  if (input.kind === 'scheduler_run_now') return input.jobId.trim().length > 0;
  if (input.kind === 'memory_review_decision') {
    return (
      input.reviewId.trim().length > 0 &&
      (input.decision === 'approve' ||
        input.decision === 'reject' ||
        input.decision === 'edit')
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
} {
  let handler: OnMessageAction | undefined;
  let memoryReviewHandler: OnMemoryReviewMessageAction | undefined;
  return {
    handle: async (input: MessageActionCallbackInput) => {
      if (!isMessageActionValid(input)) return;
      if (input.kind === 'memory_review_decision') {
        return memoryReviewHandler?.(input);
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
  };
}
