import { createHash } from 'node:crypto';
const DEFAULT_BROWSER_PROFILE_NAME = 'gantry';
function compactSegment(value) {
    const compact = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^[^a-z0-9]+/, '')
        .replace(/[^a-z0-9]+$/, '');
    return compact || 'agent';
}
function shortHash(value) {
    return createHash('sha256').update(value).digest('hex').slice(0, 12);
}
export function resolveConversationBrowserProfile(input) {
    const agent = compactSegment(input.agentId || input.workspaceKey || 'agent');
    const conversation = (input.conversationId || '').trim();
    if (!conversation)
        return DEFAULT_BROWSER_PROFILE_NAME;
    const prefix = `c-${agent}`.slice(0, 48).replace(/[^a-z0-9]+$/, '');
    return `${prefix}-${shortHash(`${agent}\n${conversation}`)}`;
}
export function formatBrowserProfileLabel(input) {
    const agent = (input.agentName || 'Agent').trim() || 'Agent';
    if (input.conversationKind === 'dm')
        return `${agent} DM browser`;
    return `${agent} conversation browser`;
}
