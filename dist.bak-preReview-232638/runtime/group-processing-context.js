import { logger } from '../infrastructure/logging/logger.js';
import { buildGroupTurnConversationContext } from './group-conversation-context.js';
export async function buildGroupProcessingConversationContext(input) {
    const { prompt, recallQuery, logContext } = await buildGroupTurnConversationContext({
        deps: input.deps,
        repository: input.repository,
        agentFolder: input.agentFolder,
        chatJid: input.chatJid,
        providerAccountId: input.providerAccountId,
        activeThreadId: input.activeThreadId,
        latestMessage: input.latestMessage,
        currentMessages: input.currentMessages,
        timezone: input.timezone,
    });
    logger.info({
        group: input.groupName,
        messageCount: input.currentMessages.length,
        ...logContext,
    }, 'Processing messages with conversation context');
    return { prompt, recallQuery };
}
