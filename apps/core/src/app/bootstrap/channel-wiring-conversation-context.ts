import type {
  ConversationContextHydrationRequest,
  ConversationContextHydrationResult,
} from './channel-wiring-types.js';

interface ChannelConversationContextProvider {
  hydrateConversationContext?: (
    request: ConversationContextHydrationRequest,
  ) => Promise<ConversationContextHydrationResult>;
}

type ConversationContextLookup = (
  conversationJid: string,
) => ChannelConversationContextProvider | undefined;

type ProviderIdResolver = (conversationJid: string, fallback: string) => string;

export async function hydrateChannelConversationContext(
  request: ConversationContextHydrationRequest,
  findBoundChannel: ConversationContextLookup,
  providerIdForJid: ProviderIdResolver,
): Promise<ConversationContextHydrationResult> {
  const channel = findBoundChannel(request.conversationJid);
  return channel?.hydrateConversationContext
    ? channel.hydrateConversationContext(request)
    : {
        providerId: providerIdForJid(request.conversationJid, '') || 'unknown',
        attempted: false,
        skipped: true,
        reason: 'unsupported',
      };
}
