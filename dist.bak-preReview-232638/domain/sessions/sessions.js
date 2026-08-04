export function scopedDigestMetadataForSession(session) {
    return {
        sessionScope: {
            appId: scopedSessionValue(session.appId),
            agentId: scopedSessionValue(session.agentId),
            conversationId: scopedSessionValue(session.conversationId),
            userId: scopedSessionValue(session.userId),
            threadId: scopedSessionValue(session.threadId),
            jobId: scopedSessionValue(session.jobId),
        },
    };
}
function scopedSessionValue(value) {
    return typeof value === 'string' && value.trim() ? value : null;
}
