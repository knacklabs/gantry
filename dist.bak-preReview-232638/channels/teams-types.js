import { getProviderRuntimeSecret } from './provider-runtime-secrets.js';
export const TEAMS_JID_PREFIX = 'teams:';
export function normalizeTeamsJid(input) {
    const trimmed = input.trim();
    if (!trimmed)
        return null;
    const conversationId = trimmed.startsWith(TEAMS_JID_PREFIX)
        ? trimmed.slice(TEAMS_JID_PREFIX.length).trim()
        : trimmed;
    return conversationId ? `${TEAMS_JID_PREFIX}${conversationId}` : null;
}
export function isTeamsJid(input) {
    return teamsConversationIdFromJid(input) !== null;
}
export function teamsConversationIdFromJid(jid) {
    const trimmed = jid.trim();
    if (!trimmed.startsWith(TEAMS_JID_PREFIX))
        return null;
    const conversationId = trimmed.slice(TEAMS_JID_PREFIX.length).trim();
    return conversationId || null;
}
export async function readTeamsCredentials(secrets, settings, providerAccountId = '') {
    const clientId = await getProviderRuntimeSecret({
        providerId: 'teams',
        providerAccountId,
        key: 'client_id',
        settings,
        secrets,
    });
    const clientSecret = await getProviderRuntimeSecret({
        providerId: 'teams',
        providerAccountId,
        key: 'client_secret',
        settings,
        secrets,
    });
    const tenantId = await getProviderRuntimeSecret({
        providerId: 'teams',
        providerAccountId,
        key: 'tenant_id',
        settings,
        secrets,
    });
    if (!clientId || !clientSecret || !tenantId)
        return null;
    return { clientId, clientSecret, tenantId };
}
