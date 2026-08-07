import type { ChannelWiring } from './channel-wiring-types.js';

/** Reaction sinks forwarded to the runtime, kept out of the composition root. */
export function liveUxReactionSinks(channelWiring: ChannelWiring) {
  return {
    addReaction: (
      ...args: Parameters<ChannelWiring['addReaction']>
    ): ReturnType<ChannelWiring['addReaction']> =>
      channelWiring.addReaction(...args),
    removeReaction: (
      ...args: Parameters<ChannelWiring['removeReaction']>
    ): ReturnType<ChannelWiring['removeReaction']> =>
      channelWiring.removeReaction(...args),
    reactionRemovalMode: (
      ...args: Parameters<ChannelWiring['reactionRemovalMode']>
    ): ReturnType<ChannelWiring['reactionRemovalMode']> =>
      channelWiring.reactionRemovalMode(...args),
  };
}
