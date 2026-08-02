import { ApplicationError } from '../application/common/application-error.js';
import { toTrimmedString } from './ipc-shared.js';
import { parseAgentThreadQueueKey } from '../shared/thread-queue-key.js';
export function schedulerAccessFromContext(context) {
    const originConversationJid = toTrimmedString(context.data.chatJid, {
        maxLen: 255,
    });
    if (!originConversationJid) {
        throw new ApplicationError('FORBIDDEN', 'Scheduler job operations require an originating conversation.');
    }
    if (!context.conversationBindings) {
        throw new Error('Scheduler IPC context missing conversation bindings.');
    }
    if (!context.sourceAgentFolderJids.includes(originConversationJid) &&
        !hasBoundOriginConversation(context)) {
        throw new ApplicationError('FORBIDDEN', 'Scheduler job operations must originate from a conversation bound to this agent.');
    }
    const originProviderAccountId = toTrimmedString(context.data.providerAccountId, {
        maxLen: 255,
    });
    if (originProviderAccountId && !hasBoundProviderAccount(context)) {
        throw new ApplicationError('FORBIDDEN', 'Scheduler job operations must originate from the authenticated provider account.');
    }
    return {
        sourceAgentFolder: context.sourceAgentFolder,
        originConversationJid,
        originProviderAccountId,
        conversationBindings: context.conversationBindings,
        sourceConversationJids: context.sourceAgentFolderJids,
        authThreadId: context.data.authThreadId,
    };
}
function hasBoundOriginConversation(context) {
    return Object.entries(context.conversationBindings).some(([key, route]) => {
        const parsed = parseAgentThreadQueueKey(key);
        return (parsed.chatJid === context.data.chatJid &&
            route.folder === context.sourceAgentFolder);
    });
}
function hasBoundProviderAccount(context) {
    const requested = toTrimmedString(context.data.providerAccountId, {
        maxLen: 255,
    });
    if (!requested)
        return true;
    return Object.entries(context.conversationBindings).some(([key, route]) => {
        const parsed = parseAgentThreadQueueKey(key);
        return (parsed.chatJid === context.data.chatJid &&
            route.folder === context.sourceAgentFolder &&
            (parsed.providerAccountId ?? route.providerAccountId) === requested);
    });
}
