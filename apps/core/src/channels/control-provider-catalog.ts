import type {
  ProviderConversationDiscoveryPort,
  DiscoveredConversation,
} from '../application/provider-conversations/provider-conversation-control-use-cases.js';
import type { ProviderCatalogPort } from '../application/provider-conversations/provider-catalog-ports.js';
import type { Provider } from '../domain/provider/provider.js';
import type { RuntimeSecretProvider } from '../domain/ports/runtime-secret-provider.js';
import type { IsoTimestamp } from '../shared/time/primitives.js';
import { listSlackRecentChats } from '../cli/slack-chat-discovery.js';
import { listTelegramRecentChats } from '../cli/telegram-chat-discovery.js';
import {
  GraphTeamsSetupDiscoveryClient,
  type TeamsSetupDiscoveryClient,
} from './teams-setup-discovery.js';
import './register-builtins.js';
import {
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
      capabilityFlags: provider.internal
        ? ['internal', 'discover']
        : ['install', 'discover'],
      allowedRuntimeSecretRefs: provider.setup.envKeys,
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
        allowedRuntimeSecretRefs: [],
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
  ) {}

  async discover(
    input: Parameters<ProviderConversationDiscoveryPort['discover']>[0],
  ) {
    const providerId = normalizeProviderId(
      String(input.providerConnection.providerId),
    );
    if (providerId === 'app') return [];
    if (providerId === 'telegram') {
      const token = this.resolveSecret(
        input.providerConnection.runtimeSecretRefs,
        ['TELEGRAM_BOT_TOKEN'],
      );
      const result = await listTelegramRecentChats({
        token,
        limit: input.limit,
      });
      if (!result.ok) {
        throw new ApplicationError('UNAVAILABLE', result.message);
      }
      return result.chats.map(
        (chat): DiscoveredConversation => ({
          externalId: chat.chatJid,
          title: chat.chatTitle,
          kind:
            chat.chatType === 'private'
              ? 'direct'
              : chat.chatType === 'channel'
                ? 'channel'
                : 'group',
          externalRef: { kind: 'conversation', value: chat.chatJid },
        }),
      );
    }
    if (providerId === 'slack') {
      const botToken = this.resolveSecret(
        input.providerConnection.runtimeSecretRefs,
        ['SLACK_BOT_TOKEN'],
      );
      const result = await listSlackRecentChats({
        botToken,
        limit: input.limit,
      });
      if (!result.ok) {
        throw new ApplicationError('UNAVAILABLE', result.message);
      }
      return result.chats.map(
        (chat): DiscoveredConversation => ({
          externalId: chat.chatJid,
          title: chat.chatTitle,
          kind: chat.chatType === 'im' ? 'direct' : 'channel',
          externalRef: { kind: 'conversation', value: chat.chatJid },
        }),
      );
    }
    if (providerId === 'teams') {
      const result = await this.teamsDiscoveryClient.listChannels({
        credentials: {
          clientId: this.resolveExactSecret(
            input.providerConnection.runtimeSecretRefs,
            'TEAMS_CLIENT_ID',
          ),
          clientSecret: this.resolveExactSecret(
            input.providerConnection.runtimeSecretRefs,
            'TEAMS_CLIENT_SECRET',
          ),
          tenantId: this.resolveExactSecret(
            input.providerConnection.runtimeSecretRefs,
            'TEAMS_TENANT_ID',
          ),
        },
        limit: input.limit,
      });
      if (!result.ok) {
        throw new ApplicationError('UNAVAILABLE', result.message);
      }
      return result.channels.map(
        (channel): DiscoveredConversation => ({
          externalId: channel.chatJid,
          title: channel.chatTitle,
          kind: 'channel',
          externalRef: { kind: 'conversation', value: channel.chatJid },
        }),
      );
    }
    throw new ApplicationError(
      'NOT_IMPLEMENTED',
      `Conversation discovery is not implemented for ${providerId}`,
    );
  }

  private resolveSecret(refs: string[], preferred: string[]): string {
    const candidates = [
      ...preferred.filter((ref) => refs.includes(ref)),
      ...refs,
    ].filter((ref, index, all) => all.indexOf(ref) === index);
    for (const ref of candidates) {
      const value = this.secrets.getOptionalSecret({ env: ref });
      if (value) return value;
    }
    throw new ApplicationError(
      'INVALID_REQUEST',
      'provider connection does not reference a configured runtime secret',
    );
  }

  private resolveExactSecret(refs: string[], ref: string): string {
    if (!refs.includes(ref)) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        `provider connection does not reference ${ref}`,
      );
    }
    const value = this.secrets.getOptionalSecret({ env: ref });
    if (value) return value;
    throw new ApplicationError(
      'INVALID_REQUEST',
      `provider connection references ${ref}, but it is not configured`,
    );
  }
}
