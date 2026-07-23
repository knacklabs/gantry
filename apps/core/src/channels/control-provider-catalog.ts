import type {
  ProviderConversationDiscoveryPort,
  DiscoveredConversation,
} from '../application/provider-conversations/provider-conversation-control-use-cases.js';
import type { ProviderCatalogPort } from '../application/provider-conversations/provider-catalog-ports.js';
import type { Provider } from '../domain/provider/provider.js';
import type { RuntimeSecretProvider } from '../domain/ports/runtime-secret-provider.js';
import {
  getOptionalRuntimeSecret,
  normalizeRuntimeSecretRefString,
} from '../domain/ports/runtime-secret-provider.js';
import { runtimeSecretKeyForEnv } from '../domain/provider/provider-runtime-secret-keys.js';
import type { IsoTimestamp } from '../shared/time/primitives.js';
import { listSlackRecentChats } from '../cli/slack-chat-discovery.js';
import { listTelegramRecentChats } from '../cli/telegram-chat-discovery.js';
import {
  GraphTeamsSetupDiscoveryClient,
  type TeamsSetupDiscoveryClient,
} from './teams-setup-discovery.js';
import {
  RestDiscordSetupDiscoveryClient,
  type DiscordSetupDiscoveryClient,
} from './discord-setup-discovery.js';
import './register-builtins.js';
import {
  getProvider,
  listChannelProviders,
  normalizeProviderId,
} from './provider-registry.js';
import { ApplicationError } from '../application/common/application-error.js';

const createdAt = '2026-04-27T00:00:00.000Z' as IsoTimestamp;

export class BuiltInControlChannelProviderCatalog implements ProviderCatalogPort {
  listProviders(): Provider[] {
    const builtIns = listChannelProviders().map((provider) => ({
      id: provider.id,
      displayName: provider.label,
      capabilityFlags:
        provider.controlCapabilityFlags ??
        (provider.internal ? ['internal'] : ['install', 'discover']),
      allowedRuntimeSecretKeys: provider.setup.envKeys.map((envKey) =>
        runtimeSecretKeyForEnv(provider.id, envKey),
      ),
      createdAt,
    })) as Provider[];
    const existingIds = new Set<string>(
      builtIns.map((provider) => String(provider.id)),
    );
    for (const id of ['teams', 'whatsapp']) {
      if (existingIds.has(id)) continue;
      builtIns.push({
        id: id as Provider['id'],
        displayName: id === 'teams' ? 'Teams' : 'WhatsApp',
        capabilityFlags: ['placeholder'],
        allowedRuntimeSecretKeys: [],
        createdAt,
      } as Provider);
    }
    return builtIns;
  }
}

export class RuntimeSecretConversationDiscovery implements ProviderConversationDiscoveryPort {
  constructor(
    private readonly secrets: RuntimeSecretProvider,
    private readonly teamsDiscoveryClient: TeamsSetupDiscoveryClient = new GraphTeamsSetupDiscoveryClient(),
    private readonly discordDiscoveryClient: DiscordSetupDiscoveryClient = new RestDiscordSetupDiscoveryClient(),
  ) {}

  async discover(
    input: Parameters<ProviderConversationDiscoveryPort['discover']>[0],
  ) {
    const providerId = normalizeProviderId(
      String(input.providerAccount.providerId),
    );
    if (!providerId) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `Unknown provider: ${input.providerAccount.providerId}`,
      );
    }
    if (providerId === 'app') return [];
    if (providerId === 'telegram') {
      const token = await this.resolveSecret(
        input.providerAccount.runtimeSecretRefs,
        ['bot_token'],
      );
      const result = await listTelegramRecentChats({
        token,
        limit: input.limit,
      });
      if (!result.ok) {
        throw new ApplicationError('UNAVAILABLE', result.message);
      }
      return filterDiscoveredConversations(
        result.chats.map((chat): DiscoveredConversation => ({
          externalId: canonicalConversationExternalId(providerId, chat.chatJid),
          title: chat.chatTitle,
          kind:
            chat.chatType === 'private'
              ? 'direct'
              : chat.chatType === 'channel'
                ? 'channel'
                : 'group',
          externalRef: {
            kind: 'conversation',
            value: canonicalConversationExternalId(providerId, chat.chatJid),
          },
        })),
        input,
      );
    }
    if (providerId === 'slack') {
      const botToken = await this.resolveSecret(
        input.providerAccount.runtimeSecretRefs,
        ['bot_token'],
      );
      const result = await listSlackRecentChats({
        botToken,
        limit: input.limit,
        includeArchived: input.includeArchived,
      });
      if (!result.ok) {
        throw new ApplicationError('UNAVAILABLE', result.message);
      }
      return filterDiscoveredConversations(
        result.chats.map((chat): DiscoveredConversation => ({
          externalId: canonicalConversationExternalId(providerId, chat.chatJid),
          title: chat.chatTitle,
          kind: chat.chatType === 'im' ? 'direct' : 'channel',
          ...(chat.isArchived === true ? { status: 'archived' } : {}),
          externalRef: {
            kind: 'conversation',
            value: canonicalConversationExternalId(providerId, chat.chatJid),
          },
        })),
        input,
      );
    }
    if (providerId === 'teams') {
      const result = await this.teamsDiscoveryClient.listChannels({
        credentials: {
          clientId: await this.resolveExactSecret(
            input.providerAccount.runtimeSecretRefs,
            'client_id',
          ),
          clientSecret: await this.resolveExactSecret(
            input.providerAccount.runtimeSecretRefs,
            'client_secret',
          ),
          tenantId: await this.resolveExactSecret(
            input.providerAccount.runtimeSecretRefs,
            'tenant_id',
          ),
        },
        limit: input.limit,
        includeArchived: input.includeArchived,
      });
      if (!result.ok) {
        throw new ApplicationError('UNAVAILABLE', result.message);
      }
      return filterDiscoveredConversations(
        result.channels.map((channel): DiscoveredConversation => ({
          externalId: canonicalConversationExternalId(
            providerId,
            channel.chatJid,
          ),
          title: channel.chatTitle,
          kind: 'channel',
          ...(channel.isArchived === true ? { status: 'archived' } : {}),
          externalRef: {
            kind: 'conversation',
            value: canonicalConversationExternalId(providerId, channel.chatJid),
          },
        })),
        input,
      );
    }
    if (providerId === 'discord') {
      const result = await this.discordDiscoveryClient.listChannels({
        credentials: {
          botToken: await this.resolveExactSecret(
            input.providerAccount.runtimeSecretRefs,
            'bot_token',
          ),
          applicationId: await this.resolveExactSecret(
            input.providerAccount.runtimeSecretRefs,
            'application_id',
          ),
        },
        limit: input.limit,
      });
      if (!result.ok) {
        throw new ApplicationError('UNAVAILABLE', result.message);
      }
      return filterDiscoveredConversations(
        result.channels.map((channel): DiscoveredConversation => ({
          externalId: canonicalConversationExternalId(
            providerId,
            channel.chatJid,
          ),
          title: channel.chatTitle,
          kind: 'channel',
          externalRef: {
            kind: 'conversation',
            value: canonicalConversationExternalId(providerId, channel.chatJid),
          },
        })),
        input,
      );
    }
    throw new ApplicationError(
      'NOT_IMPLEMENTED',
      `Conversation discovery is not implemented for ${providerId}`,
    );
  }

  private async resolveSecret(
    refs: Record<string, string>,
    preferredKeys: string[],
  ): Promise<string> {
    const candidates = preferredKeys
      .map((key) => refs[key])
      .filter((ref): ref is string => Boolean(ref?.trim()));
    for (const ref of candidates) {
      const value = await getOptionalRuntimeSecret(this.secrets, {
        ref: normalizeRuntimeSecretRefString(ref),
      });
      if (value) return value;
    }
    throw new ApplicationError(
      'INVALID_REQUEST',
      'provider connection does not reference a configured runtime secret',
    );
  }

  private async resolveExactSecret(
    refs: Record<string, string>,
    key: string,
  ): Promise<string> {
    const actualRef = refs[key];
    if (!actualRef) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `provider connection does not reference ${key}`,
      );
    }
    const value = await getOptionalRuntimeSecret(this.secrets, {
      ref: normalizeRuntimeSecretRefString(actualRef),
    });
    if (value) return value;
    throw new ApplicationError(
      'INVALID_REQUEST',
      `provider account references ${key}, but it is not configured`,
    );
  }
}

function filterDiscoveredConversations(
  conversations: DiscoveredConversation[],
  input: Parameters<ProviderConversationDiscoveryPort['discover']>[0],
): DiscoveredConversation[] {
  const query = input.query?.trim().toLowerCase();
  return conversations.filter((conversation) => {
    if (input.includeArchived !== true && conversation.status === 'archived') {
      return false;
    }
    if (!query) return true;
    return [
      conversation.externalId,
      conversation.externalRef?.value,
      conversation.title,
    ].some((value) => value?.toLowerCase().includes(query));
  });
}

function canonicalConversationExternalId(
  providerId: string,
  conversationJid: string,
): string {
  const provider = getProvider(providerId);
  const jid = conversationJid.trim();
  if (provider?.jidPrefix && jid.startsWith(provider.jidPrefix)) {
    return jid.slice(provider.jidPrefix.length);
  }
  return jid;
}
