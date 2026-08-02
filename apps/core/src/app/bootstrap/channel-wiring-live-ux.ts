import {
  asMessageReactionRemovalSink,
  asMessageReactionSink,
  asTypingSink,
} from './channel-capability-ports.js';
import type { ChannelAccountOptions } from './channel-wiring-types.js';

type CapabilityChannel = Parameters<typeof asTypingSink>[0];

export function createChannelWiringLiveUx(input: {
  findBoundChannel: (
    jid: string,
    providerAccountId?: string,
  ) => CapabilityChannel;
}) {
  return {
    setTyping: async (
      jid: string,
      isTyping: boolean,
      options?: ChannelAccountOptions,
    ) => {
      const sink = asTypingSink(
        input.findBoundChannel(jid, options?.providerAccountId),
      );
      if (!sink) return;
      if (options?.threadId) {
        await sink.setTyping(jid, isTyping, { threadId: options.threadId });
      } else {
        await sink.setTyping(jid, isTyping);
      }
    },
    addReaction: async (
      jid: string,
      ref: string,
      emoji: string,
      options?: ChannelAccountOptions,
    ) => {
      const sink = asMessageReactionSink(
        input.findBoundChannel(jid, options?.providerAccountId),
      );
      await sink?.addReaction(
        jid,
        ref,
        emoji,
        options?.threadId ? { threadId: options.threadId } : undefined,
      );
    },
    removeReaction: async (
      jid: string,
      ref: string,
      emoji: string,
      options?: ChannelAccountOptions,
    ) => {
      const sink = asMessageReactionRemovalSink(
        input.findBoundChannel(jid, options?.providerAccountId),
      );
      await sink?.removeReaction(
        jid,
        ref,
        emoji,
        options?.threadId ? { threadId: options.threadId } : undefined,
      );
    },
  };
}
