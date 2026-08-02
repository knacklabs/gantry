export function resolveAgentSessionKey(input) {
    return [
        `app=${input.appId}`,
        `agent=${input.agentId}`,
        `conversation=${input.conversationId ?? ''}`,
        `thread=${input.threadId ?? ''}`,
        `user=${input.userId ?? ''}`,
        `job=${input.jobId ?? ''}`,
    ].join('|');
}
export function deterministicAgentSessionId(input) {
    return `agent-session-key:${stableEncode(resolveAgentSessionKey(input))}`;
}
function stableEncode(value) {
    return Buffer.from(value, 'utf8').toString('base64url');
}
