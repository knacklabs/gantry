import { createHash } from 'node:crypto';
export function applyConversationInstallToSettings(input) {
    const { settings, conversation, providerAccountId, agentFolder } = input;
    const conversationKey = configuredConversationKey(settings, conversation, providerAccountId);
    const existing = settings.conversations[conversationKey];
    const externalId = conversationExternalId(conversation, providerAccountId);
    const controlApprovers = input.controlApprovers.length
        ? [...new Set(input.controlApprovers.map((value) => value.trim()))].filter(Boolean)
        : (existing?.controlApprovers ?? []);
    settings.conversations[conversationKey] = {
        providerConnection: providerAccountId,
        providerAccount: providerAccountId,
        externalId,
        kind: conversation.kind === 'direct' ? 'dm' : conversation.kind,
        displayName: conversation.title || existing?.displayName || conversationKey,
        senderPolicy: existing?.senderPolicy ?? { allow: '*', mode: 'trigger' },
        controlApprovers,
        installedAgents: {
            ...(existing?.installedAgents ?? {}),
            [agentFolder]: {
                agentId: agentFolder,
                providerAccountId,
                status: 'active',
                addedAt: input.now,
                memoryScope: 'conversation',
                trigger: `@${settings.agents[agentFolder]?.name || agentFolder}`,
                requiresTrigger: conversation.kind !== 'direct',
            },
        },
    };
    return conversationKey;
}
function conversationExternalId(conversation, providerAccountId) {
    if (conversation.externalRef?.value)
        return conversation.externalRef.value;
    // Account-qualified ids (conversation:<account>:<jid>) must fall back to
    // the provider jid, not '<account>:<jid>'.
    const bare = String(conversation.id).replace(/^conversation:/, '');
    const accountPrefix = `${providerAccountId}:`;
    return bare.startsWith(accountPrefix)
        ? bare.slice(accountPrefix.length)
        : bare;
}
function configuredConversationKey(settings, conversation, providerAccountId) {
    const externalId = conversationExternalId(conversation, providerAccountId);
    const existing = Object.entries(settings.conversations).find(([, configured]) => configured.externalId === externalId &&
        (configured.providerAccount ?? configured.providerConnection) ===
            providerAccountId);
    if (existing)
        return existing[0];
    const raw = `${providerAccountId}_${externalId}`;
    const base = raw
        .replace(/[^A-Za-z0-9_-]+/g, '_')
        .replace(/^[^A-Za-z0-9]+/, '')
        .replace(/_+/g, '_')
        .slice(0, 80)
        .replace(/[_-]+$/, '') || 'conversation';
    const hash = createHash('sha256').update(raw).digest('hex').slice(0, 12);
    return `${base}_${hash}`;
}
