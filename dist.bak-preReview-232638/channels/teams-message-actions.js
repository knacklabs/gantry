import { teamsConversationIdFromJid } from './teams-types.js';
export function readTeamsMessageAction(value) {
    const data = typeof value === 'object' && value !== null && 'data' in value
        ? value.data
        : value;
    if (typeof data !== 'object' || data === null)
        return null;
    const payload = data;
    if (payload.action !== 'message_action')
        return null;
    if (typeof payload.targetJid !== 'string') {
        return null;
    }
    if (payload.kind === 'scheduler_run_now') {
        if (typeof payload.jobId !== 'string' || !payload.jobId.trim()) {
            return null;
        }
        return {
            kind: 'scheduler_run_now',
            jobId: payload.jobId,
            targetJid: payload.targetJid,
            ...(typeof payload.threadId === 'string'
                ? { threadId: payload.threadId }
                : {}),
        };
    }
    if (payload.kind !== 'live_turn_stop')
        return null;
    if (typeof payload.actionToken !== 'string')
        return null;
    return {
        kind: 'live_turn_stop',
        actionToken: payload.actionToken,
        targetJid: payload.targetJid,
        ...(typeof payload.threadId === 'string'
            ? { threadId: payload.threadId }
            : {}),
    };
}
export async function handleTeamsMessageAction(input) {
    const payload = readTeamsMessageAction(input.message.value);
    if (!payload)
        return false;
    if (payload.targetJid !== input.jid) {
        await input.sendDenied(teamsConversationIdFromJid(input.jid), 'This action belongs to a different chat.');
        return true;
    }
    if (payload.kind === 'scheduler_run_now') {
        await input.onMessageAction?.({
            kind: 'scheduler_run_now',
            conversationJid: input.jid,
            ...(input.providerAccountId
                ? { providerAccountId: input.providerAccountId }
                : {}),
            userId: input.userId,
            jobId: payload.jobId,
            ...(payload.threadId ? { threadId: payload.threadId } : {}),
        });
        return true;
    }
    await input.onMessageAction?.({
        kind: 'live_turn_stop',
        conversationJid: input.jid,
        ...(input.providerAccountId
            ? { providerAccountId: input.providerAccountId }
            : {}),
        userId: input.userId,
        actionToken: payload.actionToken,
        ...(payload.threadId ? { threadId: payload.threadId } : {}),
    });
    return true;
}
