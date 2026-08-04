import { registerChannelPromptPresentationRenderer } from '../application/agents/prompt-profile-service.js';
const registry = new Map();
let providersByJidPrefix = [];
const builtInPrefixAliases = new Map([
    ['app', 'app'],
    ['telegram', 'telegram'],
    ['slack', 'slack'],
    ['teams', 'teams'],
    ['discord', 'discord'],
    ['tg', 'telegram'],
    ['sl', 'slack'],
    ['dc', 'discord'],
]);
const builtInProviderJidPrefixes = new Map([
    ['app', 'app:'],
    ['telegram', 'tg:'],
    ['slack', 'sl:'],
    ['teams', 'teams:'],
    ['discord', 'dc:'],
]);
function rebuildProviderPrefixCache() {
    providersByJidPrefix = [...registry.values()].sort((a, b) => b.jidPrefix.length - a.jidPrefix.length);
}
export function registerProvider(provider) {
    if (!provider.id.trim()) {
        throw new Error('Provider id must be non-empty');
    }
    if (!provider.jidPrefix.trim()) {
        throw new Error(`Provider "${provider.id}" jidPrefix must be non-empty`);
    }
    if (!provider.folderPrefix.trim()) {
        throw new Error(`Provider "${provider.id}" folderPrefix must be non-empty`);
    }
    if (registry.has(provider.id)) {
        throw new Error(`Duplicate provider id: ${provider.id}`);
    }
    for (const existing of registry.values()) {
        if (provider.jidPrefix.startsWith(existing.jidPrefix) ||
            existing.jidPrefix.startsWith(provider.jidPrefix)) {
            throw new Error(`Provider jidPrefix overlap: "${provider.id}" (${provider.jidPrefix}) conflicts with "${existing.id}" (${existing.jidPrefix})`);
        }
    }
    registry.set(provider.id, provider);
    rebuildProviderPrefixCache();
}
export function getProvider(id) {
    return registry.get(id);
}
export function normalizeProviderId(id) {
    const normalized = String(id ?? '')
        .trim()
        .toLowerCase();
    if (!normalized)
        return '';
    const direct = registry.get(normalized);
    if (direct)
        return direct.id;
    for (const provider of registry.values()) {
        const prefixAlias = provider.jidPrefix.replace(/:$/, '').toLowerCase();
        if (prefixAlias === normalized)
            return provider.id;
    }
    return builtInPrefixAliases.get(normalized) ?? '';
}
/** Provider-account id the internal control channel registers under. */
export function internalControlProviderAccountId(appId) {
    return `control:${appId}`;
}
/**
 * Fallback provider-account id for a conversation whose message carried none.
 * Internal providers (app: JIDs) have exactly one always-connected channel
 * bound as control:<appId>; minting any other synthetic id there orphans the
 * conversation from channel ownership and its turns are silently skipped.
 */
export function fallbackProviderAccountId(appId, providerId) {
    const normalized = normalizeProviderId(providerId) || providerId;
    // 'app' is the built-in internal provider; recognize it even before
    // register-builtins has populated the registry (repository-level callers).
    if (normalized === 'app' || getProvider(normalized)?.internal === true) {
        return internalControlProviderAccountId(appId);
    }
    return `channel-providerAccount:${appId}:${normalized}`;
}
export function providerJidPrefix(providerId) {
    const normalized = normalizeProviderId(providerId);
    if (!normalized)
        return '';
    return (getProvider(normalized)?.jidPrefix ??
        builtInProviderJidPrefixes.get(normalized) ??
        '');
}
export function listChannelProviders() {
    return Array.from(registry.values());
}
export function listConnectableChannelProviders() {
    return listChannelProviders().filter((provider) => provider.internal !== true);
}
export function providerForJid(jid) {
    for (const provider of providersByJidPrefix) {
        if (jid.startsWith(provider.jidPrefix)) {
            return provider;
        }
    }
    return undefined;
}
export function renderChannelPromptPresentation(chatJid, conversationKind) {
    if (!chatJid)
        return undefined;
    const kind = conversationKind === 'dm'
        ? 'direct message'
        : conversationKind === 'channel'
            ? 'group conversation'
            : 'conversation';
    const descriptor = providerForJid(chatJid)?.promptPresentation;
    if (!descriptor) {
        return `- Channel: ${kind}; outbound workspace file attachments are capped at 25MB.`;
    }
    return `- Channel: ${descriptor.label} ${kind}. ${[
        descriptor.formattingDescription,
        descriptor.maxMessageGuidance,
        descriptor.attachmentGuidance,
    ]
        .filter(Boolean)
        .join('; ')}.`;
}
registerChannelPromptPresentationRenderer(renderChannelPromptPresentation);
export function providerIdForJid(jid, fallback = 'app') {
    const provider = providerForJid(jid);
    if (provider)
        return provider.id;
    for (const [prefixAlias, providerId] of builtInPrefixAliases.entries()) {
        if (jid.startsWith(`${prefixAlias}:`))
            return providerId;
    }
    const idx = jid.indexOf(':');
    if (idx > 0)
        return normalizeProviderId(jid.slice(0, idx)) || fallback;
    return fallback;
}
