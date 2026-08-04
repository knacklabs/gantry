export function makeSessionScopeKey(agentFolder, threadId, scope) {
    const conversationJid = scope?.conversationJid?.trim();
    const providerAccountId = scope?.providerAccountId?.trim();
    const dmUserId = scope?.conversationKind === 'dm' ? scope.userId?.trim() : undefined;
    const normalizedThreadId = threadId?.trim();
    const jobId = scope?.jobId?.trim();
    const parts = [agentFolder];
    if (conversationJid) {
        parts.push(`conversation:${encodeSessionScopeComponent(conversationJid)}`);
    }
    if (providerAccountId) {
        parts.push(`provider_account:${encodeSessionScopeComponent(providerAccountId)}`);
    }
    if (dmUserId) {
        parts.push(`user:${encodeSessionScopeComponent(dmUserId)}`);
    }
    if (normalizedThreadId) {
        parts.push(`thread:${encodeSessionScopeComponent(normalizedThreadId)}`);
    }
    if (jobId) {
        parts.push(`job:${encodeSessionScopeComponent(jobId)}`);
    }
    return parts.join('::');
}
function encodeSessionScopeComponent(value) {
    return encodeURIComponent(value);
}
