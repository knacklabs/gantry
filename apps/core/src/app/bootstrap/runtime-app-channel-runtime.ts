import type { GroupProcessingDeps } from '../../runtime/group-processing-types.js';

type ChannelRuntime = GroupProcessingDeps['channelRuntime'];

export function createMutableChannelRuntime(): {
  proxy: ChannelRuntime;
  set: (runtime: ChannelRuntime) => void;
} {
  let current: ChannelRuntime = {
    hasChannel: () => false,
    supportsStreaming: () => false,
    supportsProgress: () => false,
    sendMessage: async () => {},
    sendStreamingChunk: async () => false,
    resetStreaming: () => {},
    setTyping: async () => {},
    sendProgressUpdate: async () => {},
  };
  return {
    proxy: {
      hasChannel: (chatJid, options) => current.hasChannel(chatJid, options),
      supportsStreaming: (chatJid, options) =>
        current.supportsStreaming(chatJid, options),
      supportsProgress: (chatJid, options) =>
        current.supportsProgress(chatJid, options),
      sendMessage: (chatJid, rawText, options) =>
        current.sendMessage(chatJid, rawText, options),
      sendAdaptiveCard: (chatJid, card, options) =>
        current.sendAdaptiveCard
          ? current.sendAdaptiveCard(chatJid, card, options)
          : Promise.reject(
              new Error(`Adaptive Card delivery is unavailable for ${chatJid}.`),
            ),
      sendStreamingChunk: (chatJid, rawText, options) =>
        current.sendStreamingChunk(chatJid, rawText, options),
      resetStreaming: (chatJid, options) =>
        current.resetStreaming(chatJid, options),
      setTyping: (chatJid, isTyping, options) =>
        current.setTyping(chatJid, isTyping, options),
      sendProgressUpdate: (chatJid, text, options) =>
        current.sendProgressUpdate(chatJid, text, options),
      renderAgentTodo: (...args) =>
        current.renderAgentTodo?.(...args) ?? Promise.resolve(false),
      hydrateConversationContext: (request) =>
        current.hydrateConversationContext?.(request) ??
        Promise.resolve({
          providerId: 'unknown',
          attempted: false,
          skipped: true,
          reason: 'unsupported',
        }),
      isControlApproverAllowed: (input) =>
        current.isControlApproverAllowed?.(input) ?? Promise.resolve(false),
    },
    set: (runtime) => {
      current = runtime;
    },
  };
}
