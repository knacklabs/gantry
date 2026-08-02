import { getOptionalRuntimeSecret, normalizeRuntimeSecretRefString, } from '../domain/ports/runtime-secret-provider.js';
import { runtimeSecretKeyForEnv } from '../domain/provider/provider-runtime-secret-keys.js';
import { listSlackRecentChats } from '../cli/slack-chat-discovery.js';
import { listTelegramRecentChats } from '../cli/telegram-chat-discovery.js';
import { GraphTeamsSetupDiscoveryClient, } from './teams-setup-discovery.js';
import { RestDiscordSetupDiscoveryClient, } from './discord-setup-discovery.js';
import './register-builtins.js';
import { getProvider, listChannelProviders, normalizeProviderId, } from './provider-registry.js';
import { ApplicationError } from '../application/common/application-error.js';
const createdAt = '2026-04-27T00:00:00.000Z';
export class BuiltInControlChannelProviderCatalog {
    listProviders() {
        const builtIns = listChannelProviders().map((provider) => ({
            id: provider.id,
            displayName: provider.label,
            capabilityFlags: provider.controlCapabilityFlags ??
                (provider.internal ? ['internal'] : ['install', 'discover']),
            allowedRuntimeSecretKeys: provider.setup.envKeys.map((envKey) => runtimeSecretKeyForEnv(provider.id, envKey)),
            createdAt,
        }));
        const existingIds = new Set(builtIns.map((provider) => String(provider.id)));
        for (const id of ['teams', 'whatsapp']) {
            if (existingIds.has(id))
                continue;
            builtIns.push({
                id: id,
                displayName: id === 'teams' ? 'Teams' : 'WhatsApp',
                capabilityFlags: ['placeholder'],
                allowedRuntimeSecretKeys: [],
                createdAt,
            });
        }
        return builtIns;
    }
}
export class RuntimeSecretConversationDiscovery {
    secrets;
    teamsDiscoveryClient;
    discordDiscoveryClient;
    constructor(secrets, teamsDiscoveryClient = new GraphTeamsSetupDiscoveryClient(), discordDiscoveryClient = new RestDiscordSetupDiscoveryClient()) {
        this.secrets = secrets;
        this.teamsDiscoveryClient = teamsDiscoveryClient;
        this.discordDiscoveryClient = discordDiscoveryClient;
    }
    async discover(input) {
        const providerId = normalizeProviderId(String(input.providerAccount.providerId));
        if (!providerId) {
            throw new ApplicationError('INVALID_REQUEST', `Unknown provider: ${input.providerAccount.providerId}`);
        }
        if (providerId === 'app')
            return [];
        if (providerId === 'telegram') {
            const token = await this.resolveSecret(input.providerAccount.runtimeSecretRefs, ['bot_token']);
            const result = await listTelegramRecentChats({
                token,
                limit: input.limit,
            });
            if (!result.ok) {
                throw new ApplicationError('UNAVAILABLE', result.message);
            }
            return filterDiscoveredConversations(result.chats.map((chat) => ({
                externalId: canonicalConversationExternalId(providerId, chat.chatJid),
                title: chat.chatTitle,
                kind: chat.chatType === 'private'
                    ? 'direct'
                    : chat.chatType === 'channel'
                        ? 'channel'
                        : 'group',
                externalRef: {
                    kind: 'conversation',
                    value: canonicalConversationExternalId(providerId, chat.chatJid),
                },
            })), input);
        }
        if (providerId === 'slack') {
            const botToken = await this.resolveSecret(input.providerAccount.runtimeSecretRefs, ['bot_token']);
            const result = await listSlackRecentChats({
                botToken,
                limit: input.limit,
                includeArchived: input.includeArchived,
            });
            if (!result.ok) {
                throw new ApplicationError('UNAVAILABLE', result.message);
            }
            return filterDiscoveredConversations(result.chats.map((chat) => ({
                externalId: canonicalConversationExternalId(providerId, chat.chatJid),
                title: chat.chatTitle,
                kind: chat.chatType === 'im' ? 'direct' : 'channel',
                ...(chat.isArchived === true ? { status: 'archived' } : {}),
                externalRef: {
                    kind: 'conversation',
                    value: canonicalConversationExternalId(providerId, chat.chatJid),
                },
            })), input);
        }
        if (providerId === 'teams') {
            const result = await this.teamsDiscoveryClient.listChannels({
                credentials: {
                    clientId: await this.resolveExactSecret(input.providerAccount.runtimeSecretRefs, 'client_id'),
                    clientSecret: await this.resolveExactSecret(input.providerAccount.runtimeSecretRefs, 'client_secret'),
                    tenantId: await this.resolveExactSecret(input.providerAccount.runtimeSecretRefs, 'tenant_id'),
                },
                limit: input.limit,
                includeArchived: input.includeArchived,
            });
            if (!result.ok) {
                throw new ApplicationError('UNAVAILABLE', result.message);
            }
            return filterDiscoveredConversations(result.channels.map((channel) => ({
                externalId: canonicalConversationExternalId(providerId, channel.chatJid),
                title: channel.chatTitle,
                kind: 'channel',
                ...(channel.isArchived === true ? { status: 'archived' } : {}),
                externalRef: {
                    kind: 'conversation',
                    value: canonicalConversationExternalId(providerId, channel.chatJid),
                },
            })), input);
        }
        if (providerId === 'discord') {
            const result = await this.discordDiscoveryClient.listChannels({
                credentials: {
                    botToken: await this.resolveExactSecret(input.providerAccount.runtimeSecretRefs, 'bot_token'),
                    applicationId: await this.resolveExactSecret(input.providerAccount.runtimeSecretRefs, 'application_id'),
                },
                limit: input.limit,
            });
            if (!result.ok) {
                throw new ApplicationError('UNAVAILABLE', result.message);
            }
            return filterDiscoveredConversations(result.channels.map((channel) => ({
                externalId: canonicalConversationExternalId(providerId, channel.chatJid),
                title: channel.chatTitle,
                kind: 'channel',
                externalRef: {
                    kind: 'conversation',
                    value: canonicalConversationExternalId(providerId, channel.chatJid),
                },
            })), input);
        }
        throw new ApplicationError('NOT_IMPLEMENTED', `Conversation discovery is not implemented for ${providerId}`);
    }
    async resolveSecret(refs, preferredKeys) {
        const candidates = preferredKeys
            .map((key) => refs[key])
            .filter((ref) => Boolean(ref?.trim()));
        for (const ref of candidates) {
            const value = await getOptionalRuntimeSecret(this.secrets, {
                ref: normalizeRuntimeSecretRefString(ref),
            });
            if (value)
                return value;
        }
        throw new ApplicationError('INVALID_REQUEST', 'provider connection does not reference a configured runtime secret');
    }
    async resolveExactSecret(refs, key) {
        const actualRef = refs[key];
        if (!actualRef) {
            throw new ApplicationError('INVALID_REQUEST', `provider connection does not reference ${key}`);
        }
        const value = await getOptionalRuntimeSecret(this.secrets, {
            ref: normalizeRuntimeSecretRefString(actualRef),
        });
        if (value)
            return value;
        throw new ApplicationError('INVALID_REQUEST', `provider account references ${key}, but it is not configured`);
    }
}
function filterDiscoveredConversations(conversations, input) {
    const query = input.query?.trim().toLowerCase();
    return conversations.filter((conversation) => {
        if (input.includeArchived !== true && conversation.status === 'archived') {
            return false;
        }
        if (!query)
            return true;
        return [
            conversation.externalId,
            conversation.externalRef?.value,
            conversation.title,
        ].some((value) => value?.toLowerCase().includes(query));
    });
}
function canonicalConversationExternalId(providerId, conversationJid) {
    const provider = getProvider(providerId);
    const jid = conversationJid.trim();
    if (provider?.jidPrefix && jid.startsWith(provider.jidPrefix)) {
        return jid.slice(provider.jidPrefix.length);
    }
    return jid;
}
