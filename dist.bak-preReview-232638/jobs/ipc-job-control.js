function adaptAppSession(session) {
    if (!session)
        return undefined;
    return {
        sessionId: session.sessionId,
        appId: session.appId,
        conversationJid: session.chatJid,
        workspaceKey: session.workspaceKey,
        defaultResponseMode: session.defaultResponseMode,
        defaultWebhookId: session.defaultWebhookId,
    };
}
export function adaptJobControl(control) {
    return {
        async getAppSessionById(sessionId) {
            return adaptAppSession(await control.getAppSessionById(sessionId));
        },
        async getAppSessionsByIds(sessionIds) {
            const sessions = await control.getAppSessionsByIds(sessionIds);
            return sessions
                .map((session) => adaptAppSession(session))
                .filter((session) => Boolean(session));
        },
        async getAppSessionByChatJid(conversationJid) {
            return adaptAppSession(await control.getAppSessionByChatJid(conversationJid));
        },
        async getAppSessionsByChatJids(conversationJids) {
            const sessions = await control.getAppSessionsByChatJids(conversationJids);
            return sessions
                .map((session) => adaptAppSession(session))
                .filter((session) => Boolean(session));
        },
        createJobTrigger: (input) => control.createJobTrigger(input),
        markTriggerCompleted: (triggerId, status) => control.markTriggerCompleted(triggerId, status),
        getTriggerById: (triggerId) => control.getTriggerById(triggerId),
    };
}
