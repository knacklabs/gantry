import { ChannelFactory } from './channel-provider.js';

export interface ChannelProviderSetupContext {
  runtimeHome: string;
  agentId?: string;
  agentName?: string;
  prompt: (question: string) => Promise<string>;
  confirm: (question: string) => Promise<boolean>;
}

export interface ChannelProviderSetup {
  envKeys: readonly string[];
  describe: () => string;
  run: (ctx: ChannelProviderSetupContext) => Promise<void>;
}

export interface ChannelProviderSettingsLike {
  providers?: Record<string, { enabled: boolean }>;
}

export type ChannelFormattingDialect =
  | 'none'
  | 'markdown-native'
  | 'mrkdwn'
  | 'telegram-html'
  | 'telegram-markdown-v2';

export interface Provider {
  id: string;
  label: string;
  internal?: boolean;
  controlCapabilityFlags?: readonly string[];
  jidPrefix: string;
  folderPrefix: string;
  isGroupJid: (jid: string) => boolean;
  canStreamToJid?: (jid: string) => boolean;
  formatting: ChannelFormattingDialect;
  isEnabled: (settings: ChannelProviderSettingsLike) => boolean;
  create: ChannelFactory;
  setup: ChannelProviderSetup;
}

const registry = new Map<string, Provider>();
let providersByJidPrefix: Provider[] = [];

const builtInPrefixAliases = new Map<string, string>([
  ['app', 'app'],
  ['telegram', 'telegram'],
  ['slack', 'slack'],
  ['teams', 'teams'],
  ['discord', 'discord'],
  ['tg', 'telegram'],
  ['sl', 'slack'],
  ['dc', 'discord'],
]);

const builtInProviderJidPrefixes = new Map<string, string>([
  ['app', 'app:'],
  ['telegram', 'tg:'],
  ['slack', 'sl:'],
  ['teams', 'teams:'],
  ['discord', 'dc:'],
]);

function rebuildProviderPrefixCache(): void {
  providersByJidPrefix = [...registry.values()].sort(
    (a, b) => b.jidPrefix.length - a.jidPrefix.length,
  );
}

export function registerProvider(provider: Provider): void {
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
    if (
      provider.jidPrefix.startsWith(existing.jidPrefix) ||
      existing.jidPrefix.startsWith(provider.jidPrefix)
    ) {
      throw new Error(
        `Provider jidPrefix overlap: "${provider.id}" (${provider.jidPrefix}) conflicts with "${existing.id}" (${existing.jidPrefix})`,
      );
    }
  }

  registry.set(provider.id, provider);
  rebuildProviderPrefixCache();
}

export function getProvider(id: string): Provider | undefined {
  return registry.get(id);
}

export function normalizeProviderId(id: string): string {
  const normalized = String(id ?? '')
    .trim()
    .toLowerCase();
  if (!normalized) return '';
  const direct = registry.get(normalized);
  if (direct) return direct.id;
  for (const provider of registry.values()) {
    const prefixAlias = provider.jidPrefix.replace(/:$/, '').toLowerCase();
    if (prefixAlias === normalized) return provider.id;
  }
  return builtInPrefixAliases.get(normalized) ?? '';
}

/** Provider-account id the internal control channel registers under. */
export function internalControlProviderAccountId(appId: string): string {
  return `control:${appId}`;
}

/**
 * Fallback provider-account id for a conversation whose message carried none.
 * Internal providers (app: JIDs) have exactly one always-connected channel
 * bound as control:<appId>; minting any other synthetic id there orphans the
 * conversation from channel ownership and its turns are silently skipped.
 */
export function fallbackProviderAccountId(
  appId: string,
  providerId: string,
): string {
  const normalized = normalizeProviderId(providerId) || providerId;
  // 'app' is the built-in internal provider; recognize it even before
  // register-builtins has populated the registry (repository-level callers).
  if (normalized === 'app' || getProvider(normalized)?.internal === true) {
    return internalControlProviderAccountId(appId);
  }
  return `channel-providerAccount:${appId}:${normalized}`;
}

export function providerJidPrefix(providerId: string): string {
  const normalized = normalizeProviderId(providerId);
  if (!normalized) return '';
  return (
    getProvider(normalized)?.jidPrefix ??
    builtInProviderJidPrefixes.get(normalized) ??
    ''
  );
}

export function listChannelProviders(): readonly Provider[] {
  return Array.from(registry.values());
}

export function listConnectableChannelProviders(): readonly Provider[] {
  return listChannelProviders().filter(
    (provider) => provider.internal !== true,
  );
}

export function providerForJid(jid: string): Provider | undefined {
  for (const provider of providersByJidPrefix) {
    if (jid.startsWith(provider.jidPrefix)) {
      return provider;
    }
  }
  return undefined;
}

export function providerIdForJid(jid: string, fallback = 'app'): string {
  const provider = providerForJid(jid);
  if (provider) return provider.id;
  for (const [prefixAlias, providerId] of builtInPrefixAliases.entries()) {
    if (jid.startsWith(`${prefixAlias}:`)) return providerId;
  }
  const idx = jid.indexOf(':');
  if (idx > 0) return normalizeProviderId(jid.slice(0, idx)) || fallback;
  return fallback;
}
