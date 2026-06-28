import type {
  MessageSendOptions,
  ProgressUpdateOptions,
} from '../domain/types.js';
import { buildReplaceOnlyProgressOptions } from './progress-updates.js';

const TYPING_HEARTBEAT_INTERVAL_MS = 4_000;

type GroupProgressHeartbeatLogger = {
  debug(metadata: Record<string, unknown>, message: string): void;
  info?(metadata: Record<string, unknown>, message: string): void;
};

function logProgressLifecycle(
  log: GroupProgressHeartbeatLogger,
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
  ): Promise<void>;
  onSent?: () => Promise<void> | void;
  log: GroupProgressHeartbeatLogger;
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
  ): Promise<void>;
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

export function startGroupProgressHeartbeats(input: {
  supportsProgress: boolean;
  isTypingActive: () => boolean;
  hasVisibleOutput?: () => boolean;
  getLastAgentProgressAt: () => number;
  getElapsedMs: () => number;
  chatJid: string;
  groupName: string;
  channelRuntime: {
    setTyping(jid: string, isTyping: boolean): Promise<void>;
  };
  buildProgressOptions: () => ProgressUpdateOptions | undefined;
  sendProgressToChannel(
    text: string,
    options?: ProgressUpdateOptions,
  ): Promise<void>;
  log: GroupProgressHeartbeatLogger;
}): {
  typingHeartbeatTimer: ReturnType<typeof setInterval>;
  progressTimer: ReturnType<typeof setInterval> | null;
  pause(): void;
  resume(): void;
  reset(): void;
} {
  let paused = false;
  const typingHeartbeatTimer = setInterval(() => {
    if (paused || !input.isTypingActive()) return;
    void input.channelRuntime
      .setTyping(input.chatJid, true)
      .catch((err) =>
        input.log.debug(
          { err, group: input.groupName },
          'Failed to refresh typing heartbeat',
        ),
      );
  }, TYPING_HEARTBEAT_INTERVAL_MS);
  return {
    typingHeartbeatTimer,
    progressTimer: null,
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
    },
    reset: () => undefined,
  };
}
