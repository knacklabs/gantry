import type { Conversation } from '../../domain/conversation/conversation.js';
import type {
  RuntimeConfiguredConversation,
  RuntimeProviderAccountSettings,
  RuntimeSettings,
} from './runtime-settings-types.js';
import { envRuntimeSecretRef } from '../../domain/ports/runtime-secret-provider.js';

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
  providerAccounts: Record<string, RuntimeProviderAccountSettings>,
): string {
  const connection =
    providerAccounts[conversation.providerAccount] ??
    providerAccounts[conversation.providerConnection ?? ''];
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
  if (providerId === 'telegram') {
    return { bot_token: envRuntimeSecretRef('TELEGRAM_BOT_TOKEN') };
  }
  if (providerId === 'slack') {
    return {
      bot_token: envRuntimeSecretRef('SLACK_BOT_TOKEN'),
      app_token: envRuntimeSecretRef('SLACK_APP_TOKEN'),
    };
  }
  if (providerId === 'teams') {
    return {
      client_id: envRuntimeSecretRef('TEAMS_CLIENT_ID'),
      client_secret: envRuntimeSecretRef('TEAMS_CLIENT_SECRET'),
      tenant_id: envRuntimeSecretRef('TEAMS_TENANT_ID'),
    };
  }
  if (providerId === 'discord') {
    return {
      bot_token: envRuntimeSecretRef('DISCORD_BOT_TOKEN'),
      application_id: envRuntimeSecretRef('DISCORD_APPLICATION_ID'),
    };
  }
  return {};
}

export function providerTopology(
  settings: RuntimeSettings,
): Record<string, unknown> {
  return {
    providers: settings.providers,
    providerAccounts: settings.providerAccounts,
  };
}
