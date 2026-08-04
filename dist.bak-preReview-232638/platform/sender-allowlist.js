import fs from 'node:fs';
import { GANTRY_HOME } from '../config/index.js';
import { logger } from '../infrastructure/logging/logger.js';
import '../channels/register-builtins.js';
import { loadRuntimeSettingsFromPath } from '../config/settings/runtime-settings.js';
import { settingsFilePath } from '../config/settings/runtime-home.js';
import { getProvider, listChannelProviders, providerForJid, } from '../channels/provider-registry.js';
const allowlistCache = new Map();
export function invalidateSenderAllowlistCache(filePath) {
    if (filePath) {
        allowlistCache.delete(filePath);
        return;
    }
    allowlistCache.clear();
}
const DEFAULT_CHANNEL_CONFIG = {
    default: { allow: '*', mode: 'trigger' },
    agents: {},
    logDenied: true,
};
const DEFAULT_CONTROL_CHANNEL_CONFIG = {
    default: [],
    agents: {},
};
const DEFAULT_ENTRY = {
    allow: [],
    mode: 'drop',
};
function cloneDefaultChannelConfig() {
    return {
        default: { ...DEFAULT_CHANNEL_CONFIG.default },
        agents: {},
        conversations: {},
        logDenied: DEFAULT_CHANNEL_CONFIG.logDenied,
    };
}
function createDefaultConfig() {
    const cfg = {};
    for (const provider of listChannelProviders()) {
        cfg[provider.id] = cloneDefaultChannelConfig();
    }
    return cfg;
}
function cloneDefaultControlChannelConfig() {
    return {
        default: [...DEFAULT_CONTROL_CHANNEL_CONFIG.default],
        agents: {},
        conversations: {},
    };
}
function createDefaultControlConfig() {
    const cfg = {};
    for (const provider of listChannelProviders()) {
        cfg[provider.id] = cloneDefaultControlChannelConfig();
    }
    return cfg;
}
function deriveSenderAllowlistFromSettings(settings) {
    const sender = createDefaultConfig();
    for (const binding of Object.values(settings.bindings)) {
        const conversation = settings.conversations[binding.conversation];
        if (!conversation)
            continue;
        const connection = settings.providerAccounts[conversation.providerAccount];
        if (!connection)
            continue;
        const providerId = connection.provider;
        sender[providerId] ??= cloneDefaultChannelConfig();
        const conversationJid = jidForSettingsConversation(providerId, conversation.externalId);
        sender[providerId].conversations ??= {};
        sender[providerId].conversations[conversationJid] ??= {};
        sender[providerId].conversations[conversationJid][binding.agent] =
            conversation.senderPolicy;
    }
    return sender;
}
function deriveControlAllowlistFromSettings(settings) {
    const control = createDefaultControlConfig();
    for (const binding of Object.values(settings.bindings)) {
        const conversation = settings.conversations[binding.conversation];
        if (!conversation)
            continue;
        const connection = settings.providerAccounts[conversation.providerAccount];
        if (!connection)
            continue;
        const providerId = connection.provider;
        control[providerId] ??= cloneDefaultControlChannelConfig();
        const conversationJid = jidForSettingsConversation(providerId, conversation.externalId);
        control[providerId].conversations ??= {};
        control[providerId].conversations[conversationJid] ??= {};
        control[providerId].conversations[conversationJid][binding.agent] =
            conversation.controlApprovers;
    }
    return control;
}
function cachedSettings(filePath) {
    const stat = fs.statSync(filePath);
    const existing = allowlistCache.get(filePath);
    if (existing &&
        existing.mtimeMs === stat.mtimeMs &&
        existing.size === stat.size) {
        return {
            settings: existing.settings,
            cache: existing,
        };
    }
    const settings = loadRuntimeSettingsFromPath(filePath);
    const cache = {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        settings,
    };
    allowlistCache.set(filePath, cache);
    return { settings, cache };
}
function getProviderAllowlistConfig(chatJid, cfg) {
    const providerId = providerForJid(chatJid)?.id;
    if (!providerId)
        return undefined;
    return cfg[providerId];
}
function getControlProviderAllowlistConfig(chatJid, cfg) {
    const providerId = providerForJid(chatJid)?.id;
    if (!providerId)
        return undefined;
    return cfg[providerId];
}
function jidForSettingsConversation(providerId, externalId) {
    const provider = getProvider(providerId);
    if (!provider)
        return externalId;
    return externalId.startsWith(provider.jidPrefix)
        ? externalId
        : `${provider.jidPrefix}${externalId}`;
}
export function loadSenderAllowlist(settingsPathOverride) {
    const filePath = settingsPathOverride ?? settingsFilePath(GANTRY_HOME);
    try {
        const { settings, cache } = cachedSettings(filePath);
        cache.sender ??= deriveSenderAllowlistFromSettings(settings);
        return cache.sender;
    }
    catch (err) {
        const code = err?.code;
        if (code === 'ENOENT')
            return createDefaultConfig();
        logger.warn({
            err: err instanceof Error ? err.message : String(err),
            path: filePath,
        }, 'sender-allowlist: invalid settings.yaml; using defaults');
        return createDefaultConfig();
    }
}
export function loadSenderControlAllowlist(settingsPathOverride) {
    const filePath = settingsPathOverride ?? settingsFilePath(GANTRY_HOME);
    try {
        const { settings, cache } = cachedSettings(filePath);
        cache.control ??= deriveControlAllowlistFromSettings(settings);
        return cache.control;
    }
    catch (err) {
        const code = err?.code;
        if (code === 'ENOENT')
            return createDefaultControlConfig();
        logger.warn({
            err: err instanceof Error ? err.message : String(err),
            path: filePath,
        }, 'sender-control-allowlist: invalid settings.yaml; using defaults');
        return createDefaultControlConfig();
    }
}
function getEntry(chatJid, cfg, agentFolder) {
    const providerCfg = getProviderAllowlistConfig(chatJid, cfg);
    if (!providerCfg)
        return DEFAULT_ENTRY;
    if (agentFolder) {
        const byConversation = providerCfg.conversations?.[chatJid]?.[agentFolder];
        if (byConversation)
            return byConversation;
        const byAgent = providerCfg.agents[agentFolder];
        if (byAgent)
            return byAgent;
    }
    return providerCfg.default;
}
function getControlSenders(chatJid, cfg, agentFolder) {
    const providerCfg = getControlProviderAllowlistConfig(chatJid, cfg);
    if (!providerCfg)
        return [];
    if (agentFolder) {
        const byConversation = providerCfg.conversations?.[chatJid]?.[agentFolder];
        if (byConversation)
            return byConversation;
        const byAgent = providerCfg.agents[agentFolder];
        if (byAgent)
            return byAgent;
    }
    return providerCfg.default;
}
export function isSenderAllowed(chatJid, sender, cfg, agentFolder) {
    const entry = getEntry(chatJid, cfg, agentFolder);
    if (entry.allow === '*')
        return true;
    return entry.allow.includes(sender);
}
export function isSenderExplicitlyAllowed(chatJid, sender, cfg, agentFolder) {
    const entry = getEntry(chatJid, cfg, agentFolder);
    if (entry.allow === '*')
        return false;
    return entry.allow.includes(sender);
}
export function isSenderControlAllowed(chatJid, sender, cfg, agentFolder) {
    return getControlSenders(chatJid, cfg, agentFolder).includes(sender);
}
export function shouldDropMessage(chatJid, cfg, agentFolder) {
    return getEntry(chatJid, cfg, agentFolder).mode === 'drop';
}
export function isTriggerAllowed(chatJid, sender, cfg, agentFolder) {
    const allowed = isSenderAllowed(chatJid, sender, cfg, agentFolder);
    if (!allowed && shouldLogDenied(chatJid, cfg)) {
        logger.debug({ chatJid, sender, agentFolder }, 'sender-allowlist: trigger denied for sender');
    }
    return allowed;
}
export function shouldLogDenied(chatJid, cfg) {
    return getProviderAllowlistConfig(chatJid, cfg)?.logDenied ?? true;
}
