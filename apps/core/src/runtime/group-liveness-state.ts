import type { ProgressUpdateOptions } from '../domain/types.js';
import type { GroupProcessingDeps } from './group-processing-types.js';
import {
  STALL_HEARTBEAT_THRESHOLD_MS,
  startGroupProgressHeartbeats,
} from './group-progress-heartbeats.js';

export function createGroupTurnTypingSender(input: {
  channelRuntime: GroupProcessingDeps['channelRuntime'];
  chatJid: string;
  providerAccountId?: string;
  activeThreadId?: string;
}) {
  const options =
    input.providerAccountId || input.activeThreadId
      ? {
          ...(input.providerAccountId
            ? { providerAccountId: input.providerAccountId }
            : {}),
          ...(input.activeThreadId ? { threadId: input.activeThreadId } : {}),
        }
      : undefined;
  return (isTyping: boolean) =>
    options
      ? input.channelRuntime.setTyping(input.chatJid, isTyping, options)
      : input.channelRuntime.setTyping(input.chatJid, isTyping);
}

export function startGroupLivenessHeartbeat(input: {
  supportsProgress: boolean;
  isTypingActive: () => boolean;
  chatJid: string;
  providerAccountId?: string;
  activeThreadId?: string;
  groupName: string;
  channelRuntime: GroupProcessingDeps['channelRuntime'];
  buildProgressOptions: (options: {
    replaceOnly: true;
  }) => ProgressUpdateOptions;
  sendProgressToChannel: (
    text: string,
    options?: ProgressUpdateOptions,
  ) => Promise<boolean>;
  log: Parameters<typeof startGroupProgressHeartbeats>[0]['log'];
}) {
  let lastOutputAt = Date.now();
  let stallNoticeSent = false;
  const resetStallEpoch = () => {
    lastOutputAt = Date.now();
    stallNoticeSent = false;
  };
  const heartbeat = startGroupProgressHeartbeats({
    ...input,
    isStalled: () => Date.now() - lastOutputAt >= STALL_HEARTBEAT_THRESHOLD_MS,
    claimStallNotice: () => {
      if (stallNoticeSent) return false;
      stallNoticeSent = true;
      return true;
    },
    releaseStallNotice: () => {
      stallNoticeSent = false;
    },
    sendStallProgress: () =>
      input.supportsProgress
        ? input.sendProgressToChannel(
            'Still working',
            input.buildProgressOptions({ replaceOnly: true }),
          )
        : Promise.resolve(false),
  });
  return { ...heartbeat, resetStallEpoch };
}
