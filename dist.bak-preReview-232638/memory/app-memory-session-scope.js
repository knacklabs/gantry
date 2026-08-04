const CONVERSATION_ID_PREFIX = 'conversation:';
export function parseSessionScopeKey(input) {
    const raw = input.session.userId?.trim();
    if (!raw)
        return { isScopeKey: false };
    const parts = raw.split('::');
    if (parts.length > 1) {
        const groupId = decodeSessionScopeComponent(parts[0]?.trim() ?? '');
        if (groupId)
            return { isScopeKey: true, groupId };
    }
    if (input.session.agentId === `agent:${raw}`) {
        return { isScopeKey: true, groupId: raw };
    }
    return { isScopeKey: false };
}
function decodeSessionScopeComponent(value) {
    if (!value)
        return '';
    try {
        return decodeURIComponent(value).trim();
    }
    catch {
        return value.trim();
    }
}
export function conversationJidFromSession(session) {
    const id = session.conversationId?.trim();
    if (!id || !id.startsWith(CONVERSATION_ID_PREFIX))
        return undefined;
    const jid = id.slice(CONVERSATION_ID_PREFIX.length).trim();
    return jid || undefined;
}
