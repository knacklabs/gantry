import type {
  MessageSendOptions,
  ProgressUpdateOptions,
} from '../domain/types.js';
import { buildReplaceOnlyProgressOptions } from './progress-updates.js';
import { formatElapsed } from './time-format.js';
import { nowMs as currentTimeMs } from '../shared/time/datetime.js';

const TYPING_HEARTBEAT_INTERVAL_MS = 4_000;
const ELAPSED_PROGRESS_INTERVAL_MS = 60_000;
const NO_OUTPUT_WARNING_INTERVAL_MS = 180_000;
const INITIAL_PROGRESS_DELAY_MS = 750;

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
  buildMessageOptions: (threadId?: string) => MessageSendOptions | undefined;
  buildProgressOptions?: () => ProgressUpdateOptions | undefined;
  sendProgressToChannel(
    text: string,
    options?: ProgressUpdateOptions,
  ): Promise<void>;
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
    { group: input.groupName, delayMs: INITIAL_PROGRESS_DELAY_MS },
    'Progress lifecycle initial scheduled',
  );
  let cancelled = false;
  let sendStarted: Promise<void> | undefined;
  let resolveFinished: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    timer = undefined;
    if (cancelled) {
      logProgressLifecycle(
        input.log,
        { group: input.groupName },
        'Progress lifecycle initial timer skipped after cancel',
      );
      resolveFinished();
      return;
    }
    logProgressLifecycle(
      input.log,
      { group: input.groupName },
      'Progress lifecycle initial sending',
    );
    sendStarted = input
      .sendProgressToChannel(
        'Working on it...',
        input.buildProgressOptions?.() ?? input.buildMessageOptions(),
      )
      .then(() =>
        logProgressLifecycle(
          input.log,
          { group: input.groupName },
          'Progress lifecycle initial sent',
        ),
      )
      .catch((err) =>
        input.log.debug(
          { err, group: input.groupName },
          'Failed to send initial progress update',
        ),
      )
      .finally(resolveFinished);
  }, INITIAL_PROGRESS_DELAY_MS);

  return {
    cancel: async () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
        logProgressLifecycle(
          input.log,
          { group: input.groupName },
          'Progress lifecycle initial cancelled before send',
        );
        resolveFinished();
      }
      await (sendStarted ?? finished);
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
  buildMessageOptions: (threadId?: string) => MessageSendOptions | undefined;
  buildProgressOptions?: () => ProgressUpdateOptions | undefined;
  sendProgressToChannel(
    text: string,
    options?: ProgressUpdateOptions,
  ): Promise<void>;
  log: GroupProgressHeartbeatLogger;
}): {
  typingHeartbeatTimer: ReturnType<typeof setInterval>;
  progressTimer: ReturnType<typeof setInterval>;
  pause(): void;
  resume(): void;
  reset(): void;
} {
  let lastElapsedProgressAt = currentTimeMs();
  let lastNoOutputWarningAt = 0;
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
  const progressTimer = setInterval(() => {
    void (async () => {
      if (!input.supportsProgress || paused || !input.isTypingActive()) return;
      const now = currentTimeMs();
      const elapsedMs = input.getElapsedMs();
      if (
        !input.hasVisibleOutput?.() &&
        now - lastElapsedProgressAt >= ELAPSED_PROGRESS_INTERVAL_MS
      ) {
        lastElapsedProgressAt = now;
        const progressOptions =
          input.buildProgressOptions?.() ?? input.buildMessageOptions();
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
        const progressOptions =
          input.buildProgressOptions?.() ?? input.buildMessageOptions();
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
  return {
    typingHeartbeatTimer,
    progressTimer,
    pause: () => {
      paused = true;
    },
    resume: () => {
      paused = false;
    },
    reset: () => {
      lastElapsedProgressAt = currentTimeMs();
      lastNoOutputWarningAt = 0;
    },
  };
}
