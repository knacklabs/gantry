import type {
  MessageActionCallbackInput,
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

export function createChannelMessageActionRouter(): {
  handle: OnMessageAction;
  trackProgress: (
    conversationJid: string,
    options?: ProgressUpdateOptions,
  ) => void;
  set: (handler: OnMessageAction | undefined) => void;
} {
  let handler: OnMessageAction | undefined;
  return {
    handle: async (input: MessageActionCallbackInput) => {
      if (!isLiveStopActionTokenValid(input)) return;
      await handler?.(input);
    },
    trackProgress: () => {},
    set: (next: OnMessageAction | undefined) => {
      handler = next;
    },
  };
}
