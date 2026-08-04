export async function hydrateChannelConversationContext(request, findBoundChannel, providerIdForJid) {
    const channel = findBoundChannel(request.conversationJid, request.providerAccountId ?? undefined);
    return channel?.hydrateConversationContext
        ? channel.hydrateConversationContext(request)
        : {
            providerId: providerIdForJid(request.conversationJid, '') || 'unknown',
            attempted: false,
            skipped: true,
            reason: 'unsupported',
        };
}
