export function canonicalConversationIdForPattern(value) {
    const trimmed = value?.trim();
    if (!trimmed)
        return undefined;
    return trimmed.startsWith('conversation:')
        ? trimmed
        : `conversation:${trimmed}`;
}
export function patternSubjectForScope(scope) {
    const appId = scope.appId.trim();
    const agentId = scope.agentId.trim();
    const folder = scope.folder.trim();
    if (scope.conversationKind === 'dm') {
        const userId = scope.userId?.trim();
        if (!userId)
            return null;
        return {
            appId,
            agentId,
            folder,
            subjectType: 'user',
            subjectId: userId,
        };
    }
    const channelId = canonicalConversationIdForPattern(scope.conversationId);
    if (channelId) {
        return {
            appId,
            agentId,
            folder,
            subjectType: 'channel',
            subjectId: channelId,
        };
    }
    return {
        appId,
        agentId,
        folder,
        subjectType: 'group',
        subjectId: folder,
    };
}
