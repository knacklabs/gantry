import type {
  MessageSendOptions,
  ProgressUpdateOptions,
} from '../domain/types.js';
import { buildReplaceOnlyProgressOptions } from './progress-updates.js';

export function createResponseProgressSenders(input: {
  supportsProgress: boolean;
  activeThreadId?: string;
  progressGeneration?: () => number | undefined;
  buildMessageOptions: (threadId?: string) => MessageSendOptions | undefined;
  sendMessageToChannel(
    text: string,
    options?: MessageSendOptions,
  ): Promise<void>;
  sendProgressToChannel(
    text: string,
    options?: ProgressUpdateOptions,
  ): Promise<void | boolean>;
}) {
  return {
    sendWaitingProgress: () =>
      input.supportsProgress
        ? input
            .sendProgressToChannel(
              'Waiting for your input.',
              buildReplaceOnlyProgressOptions(
                input.activeThreadId,
                input.progressGeneration?.(),
              ),
            )
            .catch(() => undefined)
        : Promise.resolve(),
    sendResponseReceipt: async () => {
      if (input.supportsProgress) {
        return input
          .sendProgressToChannel(
            'Response received. Continuing...',
            buildReplaceOnlyProgressOptions(
              input.activeThreadId,
              input.progressGeneration?.(),
            ),
          )
          .catch(() => undefined);
      }
      return Promise.resolve();
    },
  };
}
