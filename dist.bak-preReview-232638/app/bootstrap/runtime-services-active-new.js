import { encodeGroupMessageCursor, toGroupMessageCursor, } from '../../shared/message-cursor.js';
import { resolveRuntimeExecutionProviderId } from '../../runtime/execution-provider-id.js';
export function controlAckMessageOptions(threadId, providerAccountId) {
    return threadId || providerAccountId
        ? {
            ...(threadId ? { threadId } : {}),
            ...(providerAccountId ? { providerAccountId } : {}),
        }
        : undefined;
}
export async function handleActiveNewSessionCommand(input) {
    const { app, channelWiring, opsRepository, collectSessionMemory, logger, group, chatJid, queueJid, threadId, message, } = input;
    let boundaryAgentSessionId;
    const defaultScope = group.conversationKind === 'dm' ? 'user' : 'group';
    const memoryUserId = message.sender?.trim() || undefined;
    const messageOptions = controlAckMessageOptions(threadId, group.providerAccountId);
    try {
        const turnContext = await opsRepository.getAgentTurnContext?.({
            agentFolder: group.folder,
            executionProviderId: resolveRuntimeExecutionProviderId(input.executionAdapter),
            conversationJid: chatJid,
            providerAccountId: group.providerAccountId,
            threadId,
            conversationKind: group.conversationKind,
            memoryUserId,
            hydrateMemory: false,
        });
        boundaryAgentSessionId = turnContext?.agentSessionId;
    }
    catch (err) {
        logger.warn({ err, chatJid, threadId }, 'Failed to capture active session boundary for /new; continuing with reset');
    }
    if (!app.queue.stopGroup(queueJid))
        return false;
    try {
        await app.clearSessionForChatJid(queueJid, threadId, {
            memoryUserId,
            providerAccountId: group.providerAccountId,
        });
    }
    catch (err) {
        logger.warn({ err, chatJid, threadId }, 'Failed to clear active session for /new');
        await channelWiring.sendMessage(chatJid, 'Could not start a fresh session because session state could not be persisted. The active run was stopped; existing session state was left unchanged.', {
            durability: 'required',
            ...(messageOptions ? { messageOptions } : {}),
        });
        return true;
    }
    if (boundaryAgentSessionId) {
        void collectSessionMemory({
            agentSessionId: boundaryAgentSessionId,
            trigger: 'session-end',
            defaultScope,
        }).catch((err) => {
            logger.warn({ err, chatJid, threadId, agentSessionId: boundaryAgentSessionId }, 'Failed to finalize active session memory after /new');
        });
    }
    app.setAgentCursor(queueJid, encodeGroupMessageCursor(toGroupMessageCursor(message)));
    await app.saveState();
    await channelWiring.sendMessage(chatJid, 'Started a fresh session.', {
        durability: 'required',
        ...(messageOptions ? { messageOptions } : {}),
    });
    return true;
}
