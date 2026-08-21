import type {
  MessageSendOptions,
  ProgressUpdateOptions,
} from '../domain/types.js';
import { buildReplaceOnlyProgressOptions } from './progress-updates.js';

type GroupProgressLogger = {
  debug(metadata: Record<string, unknown>, message: string): void;
  info?(metadata: Record<string, unknown>, message: string): void;
};

function logProgressLifecycle(
  log: GroupProgressLogger,
  metadata: Record<string, unknown>,
  message: string,
): void {
  if (log.info) {
    log.info(metadata, message);
  } else {
    log.debug(metadata, message);
  }
}

export function startInitialGroupProgress(input: {
  supportsProgress: boolean;
  groupName: string;
  buildProgressOptions: () => ProgressUpdateOptions | undefined;
  sendProgressToChannel(
    text: string,
    options?: ProgressUpdateOptions,
  ): Promise<void | boolean>;
  onSent?: () => Promise<void> | void;
  log: GroupProgressLogger;
}): { cancel(): Promise<void> } {
  if (!input.supportsProgress) {
    logProgressLifecycle(
      input.log,
      { group: input.groupName, supportsProgress: false },
      'Progress lifecycle initial skipped',
    );
    return { cancel: async () => undefined };
  }
  logProgressLifecycle(
    input.log,
    { group: input.groupName },
    'Progress lifecycle initial Stop affordance send',
  );
  const send = input
    .sendProgressToChannel('', {
      ...input.buildProgressOptions(),
      actionOnly: true,
    })
    .then(() => input.onSent?.())
    .catch((err) =>
      input.log.debug(
        { err, group: input.groupName },
        'Progress lifecycle initial Stop affordance failed',
      ),
    );

  return {
    cancel: async () => {
      await send;
    },
  };
}

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
