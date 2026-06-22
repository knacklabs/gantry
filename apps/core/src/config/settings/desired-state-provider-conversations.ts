import type { Conversation } from '../../domain/conversation/conversation.js';
import type {
  RuntimeConfiguredConversation,
  RuntimeProviderConnectionSettings,
  RuntimeSettings,
} from './runtime-settings-types.js';

export interface SettingsProviderJidInfo {
  id: string;
  label: string;
  jidPrefix: string;
  isGroupJid(jid: string): boolean;
}

const SETTINGS_PROVIDER_JID_INFO: SettingsProviderJidInfo[] = [
  {
    id: 'telegram',
    label: 'Telegram',
    jidPrefix: 'tg:',
    isGroupJid: (jid: string) => jid.startsWith('tg:-'),
  },
  {
    id: 'slack',
    label: 'Slack',
    jidPrefix: 'sl:',
    isGroupJid: () => true,
  },
  {
    id: 'teams',
    label: 'Teams',
    jidPrefix: 'teams:',
    isGroupJid: (jid: string) => jid.startsWith('teams:'),
  },
  {
    id: 'discord',
    label: 'Discord',
    jidPrefix: 'dc:',
    isGroupJid: (jid: string) => jid.startsWith('dc:'),
  },
  {
    id: 'app',
    label: 'App',
    jidPrefix: 'app:',
    isGroupJid: () => true,
  },
].sort((left, right) => right.jidPrefix.length - left.jidPrefix.length);

export function providerInfoForJid(
  jid: string,
): SettingsProviderJidInfo | undefined {
  return SETTINGS_PROVIDER_JID_INFO.find((provider) =>
    jid.startsWith(provider.jidPrefix),
  );
}

function providerInfoForId(
  providerId: string,
): SettingsProviderJidInfo | undefined {
  return SETTINGS_PROVIDER_JID_INFO.find(
    (provider) => provider.id === providerId,
  );
}

export function stripProviderPrefix(jid: string): string {
  const provider = providerInfoForJid(jid);
  if (provider && jid.startsWith(provider.jidPrefix)) {
    return jid.slice(provider.jidPrefix.length);
  }
  const idx = jid.indexOf(':');
  return idx > 0 ? jid.slice(idx + 1) : jid;
}

export function jidForConfiguredConversation(
  conversation: RuntimeConfiguredConversation,
  providerConnections: Record<string, RuntimeProviderConnectionSettings>,
): string {
  const connection = providerConnections[conversation.providerConnection];
  const provider = connection
    ? providerInfoForId(connection.provider)
    : undefined;
  if (!provider) return conversation.externalId;
  return conversation.externalId.startsWith(provider.jidPrefix)
    ? conversation.externalId
    : `${provider.jidPrefix}${conversation.externalId}`;
}

export function configuredConversationKind(
  kind: RuntimeConfiguredConversation['kind'],
): Conversation['kind'] {
  if (kind === 'dm') return 'direct';
  if (kind === 'chat') return 'group';
  return kind;
}

export function defaultRuntimeSecretRefs(
  providerId: string,
): Record<string, string> {
  if (providerId === 'telegram') return { bot_token: 'TELEGRAM_BOT_TOKEN' };
  if (providerId === 'slack') {
    return {
      bot_token: 'SLACK_BOT_TOKEN',
      app_token: 'SLACK_APP_TOKEN',
    };
  }
  if (providerId === 'teams') {
    return {
      client_id: 'TEAMS_CLIENT_ID',
      client_secret: 'TEAMS_CLIENT_SECRET',
      tenant_id: 'TEAMS_TENANT_ID',
    };
  }
  if (providerId === 'discord') {
    return {
      bot_token: 'DISCORD_BOT_TOKEN',
      application_id: 'DISCORD_APPLICATION_ID',
    };
  }
  return {};
}

export function providerTopology(
  settings: RuntimeSettings,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(settings.providers).map(([providerId, provider]) => [
      providerId,
      {
        enabled: provider.enabled,
        defaultConnection: provider.defaultConnection,
      },
    ]),
  );
}
