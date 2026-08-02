import type {
  MessageSendOptions,
  ProgressUpdateOptions,
} from '../domain/types.js';
import { buildReplaceOnlyProgressOptions } from './progress-updates.js';

const TYPING_HEARTBEAT_INTERVAL_MS = 4_000;
export const STALL_HEARTBEAT_THRESHOLD_MS = 180_000;

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
  ): Promise<void | boolean>;
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

export function startGroupProgressHeartbeats(input: {
  supportsProgress: boolean;
  isTypingActive: () => boolean;
  chatJid: string;
  providerAccountId?: string;
  activeThreadId?: string;
  groupName: string;
  isStalled: () => boolean;
  claimStallNotice: () => boolean;
  releaseStallNotice: () => void;
  sendStallProgress: () => Promise<boolean>;
  beforeVisibleDelivery: () => Promise<void>;
  cancelPendingStallNotices: () => void;
  channelRuntime: {
    setTyping(
      jid: string,
      isTyping: boolean,
      options?: { providerAccountId?: string; threadId?: string },
    ): Promise<void>;
  };
  log: GroupProgressHeartbeatLogger;
}): {
  typingHeartbeatTimer: ReturnType<typeof setInterval>;
  pause(): void;
  resume(): void;
  beginVisibleDelivery(): Promise<void>;
  finishVisibleDelivery(delivered: boolean): void;
} {
  let paused = false;
  let visibleDeliveryInFlight = false;
  let visibleDeliveryStartedAt = 0;
  let lifecycleEpoch = 0;
  const visibleDeliveryIsSuppressed = () =>
    visibleDeliveryInFlight &&
    Date.now() - visibleDeliveryStartedAt < STALL_HEARTBEAT_THRESHOLD_MS;
  const refreshTyping = () => {
    const typing =
      input.providerAccountId || input.activeThreadId
        ? input.channelRuntime.setTyping(input.chatJid, true, {
            ...(input.providerAccountId
              ? { providerAccountId: input.providerAccountId }
              : {}),
            ...(input.activeThreadId ? { threadId: input.activeThreadId } : {}),
          })
        : input.channelRuntime.setTyping(input.chatJid, true);
    void typing.catch((err) =>
      input.log.debug(
        { err, group: input.groupName },
        'Failed to refresh typing heartbeat',
      ),
    );
  };
  const typingHeartbeatTimer = setInterval(() => {
    if (paused || !input.isTypingActive()) return;
    if (visibleDeliveryIsSuppressed()) {
      refreshTyping();
      return;
    }
    const stalled = input.isStalled();
    if (stalled && input.claimStallNotice()) {
      const requestEpoch = lifecycleEpoch;
      void input
        .sendStallProgress()
        .then((landed) => {
          if (
            paused ||
            visibleDeliveryIsSuppressed() ||
            requestEpoch !== lifecycleEpoch
          ) {
            return;
          }
          if (landed) return;
          input.releaseStallNotice();
          refreshTyping();
        })
        .catch((err: unknown) => {
          if (
            paused ||
            visibleDeliveryIsSuppressed() ||
            requestEpoch !== lifecycleEpoch
          ) {
            return;
          }
          input.releaseStallNotice();
          refreshTyping();
          input.log.debug(
            { err, group: input.groupName },
            'Failed to send stalled progress heartbeat',
          );
        });
    }
    if (stalled) return;
    refreshTyping();
  }, TYPING_HEARTBEAT_INTERVAL_MS);
  return {
    typingHeartbeatTimer,
    pause: () => {
      paused = true;
      lifecycleEpoch += 1;
      input.releaseStallNotice();
      input.cancelPendingStallNotices();
    },
    resume: () => {
      paused = false;
    },
    beginVisibleDelivery: async () => {
      visibleDeliveryInFlight = true;
      visibleDeliveryStartedAt = Date.now();
      lifecycleEpoch += 1;
      input.releaseStallNotice();
      input.cancelPendingStallNotices();
      await input.beforeVisibleDelivery();
    },
    finishVisibleDelivery: (delivered) => {
      visibleDeliveryInFlight = false;
      if (delivered) {
        lifecycleEpoch += 1;
        input.releaseStallNotice();
      }
    },
  };
}
