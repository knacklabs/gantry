import type {
  MessageSendOptions,
  ProgressUpdateOptions,
} from '../domain/types.js';
import { buildReplaceOnlyProgressOptions } from './progress-updates.js';
import { formatElapsed } from './time-format.js';

const TYPING_HEARTBEAT_INTERVAL_MS = 4_000;
const ELAPSED_PROGRESS_INTERVAL_MS = 60_000;
const NO_OUTPUT_WARNING_INTERVAL_MS = 180_000;

type GroupProgressHeartbeatLogger = {
  debug(metadata: Record<string, unknown>, message: string): void;
};

export async function sendInitialGroupProgress(input: {
  supportsProgress: boolean;
  groupName: string;
  buildMessageOptions: (threadId?: string) => MessageSendOptions | undefined;
  sendProgressToChannel(
    text: string,
    options?: ProgressUpdateOptions,
  ): Promise<void>;
  log: GroupProgressHeartbeatLogger;
}): Promise<void> {
  if (!input.supportsProgress) return;
  try {
    await input.sendProgressToChannel(
      'Working on it...',
      input.buildMessageOptions(),
    );
  } catch (err) {
    input.log.debug(
      { err, group: input.groupName },
      'Failed to send initial progress update',
    );
  }
}

export function createResponseProgressSenders(input: {
  supportsProgress: boolean;
  activeThreadId?: string;
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
              buildReplaceOnlyProgressOptions(input.activeThreadId),
            )
            .catch(() => undefined)
        : Promise.resolve(),
    sendResponseReceipt: async () => {
      if (input.supportsProgress) {
        return input
          .sendProgressToChannel(
            'Response received. Continuing...',
            buildReplaceOnlyProgressOptions(input.activeThreadId),
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
  getLastAgentProgressAt: () => number;
  startedAt: number;
  chatJid: string;
  groupName: string;
  channelRuntime: {
    setTyping(jid: string, isTyping: boolean): Promise<void>;
  };
  buildMessageOptions: (threadId?: string) => MessageSendOptions | undefined;
  sendProgressToChannel(
    text: string,
    options?: ProgressUpdateOptions,
  ): Promise<void>;
  log: GroupProgressHeartbeatLogger;
}): {
  typingHeartbeatTimer: ReturnType<typeof setInterval>;
  progressTimer: ReturnType<typeof setInterval>;
} {
  let lastElapsedProgressAt = 0;
  let lastNoOutputWarningAt = 0;
  const typingHeartbeatTimer = setInterval(() => {
    if (!input.isTypingActive()) return;
    void input.channelRuntime
      .setTyping(input.chatJid, true)
      .catch((err) =>
        input.log.debug(
          { err, group: input.groupName },
          'Failed to refresh typing heartbeat',
        ),
      );
  }, TYPING_HEARTBEAT_INTERVAL_MS);
  const progressTimer = setInterval(() => {
    void (async () => {
      if (!input.supportsProgress || !input.isTypingActive()) return;
      const now = Date.now();
      const elapsedMs = now - input.startedAt;
      if (now - lastElapsedProgressAt >= ELAPSED_PROGRESS_INTERVAL_MS) {
        lastElapsedProgressAt = now;
        const progressOptions = input.buildMessageOptions();
        void input
          .sendProgressToChannel(
            `Still working (${formatElapsed(elapsedMs)})...`,
            progressOptions,
          )
          .catch((err) =>
            input.log.debug(
              { err, group: input.groupName },
              'Failed to send elapsed progress update',
            ),
          );
      }
      if (
        now - input.getLastAgentProgressAt() >= NO_OUTPUT_WARNING_INTERVAL_MS &&
        now - lastNoOutputWarningAt >= NO_OUTPUT_WARNING_INTERVAL_MS
      ) {
        lastNoOutputWarningAt = now;
        const progressOptions = input.buildMessageOptions();
        void input
          .sendProgressToChannel(
            `No new output yet, still running (${formatElapsed(elapsedMs)})...`,
            progressOptions,
          )
          .catch((err) =>
            input.log.debug(
              { err, group: input.groupName },
              'Failed to send no-output warning',
            ),
          );
      }
    })();
  }, 5_000);
  return { typingHeartbeatTimer, progressTimer };
}
