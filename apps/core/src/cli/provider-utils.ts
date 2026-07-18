import '../channels/register-builtins.js';
import {
  getProvider,
  listConnectableChannelProviders,
  providerForJid,
} from '../channels/provider-registry.js';
import { ApplicationError } from '../application/common/application-error.js';
import { gantryRuntimeSecretRef } from '../domain/ports/runtime-secret-provider.js';

export type RuntimeProviderId = string;

export function getProviderIds(): RuntimeProviderId[] {
  return listConnectableChannelProviders().map((provider) => provider.id);
}

export function parseRuntimeProvider(raw: string): RuntimeProviderId | null {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return null;
  if (
    listConnectableChannelProviders().some(
      (provider) => provider.id === normalized,
    )
  ) {
    return normalized;
  }
  for (const provider of listConnectableChannelProviders()) {
    const shortPrefix = provider.jidPrefix.replace(/:$/, '').toLowerCase();
    if (normalized === shortPrefix) {
      return provider.id;
    }
  }
  return null;
}

export function providerFromGroupJid(jid: string): RuntimeProviderId | null {
  return providerForJid(jid)?.id ?? null;
}

export function option(args: string[], name: string): string {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] || '').trim() : '';
}

export function parseRuntimeSecretRefOptions(
  args: string[],
): Record<string, string> {
  const refs: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== '--secret-ref') continue;
    const [key, ref] = (args[index + 1] || '').split('=', 2);
    if (!key?.trim() || !ref?.trim()) {
      throw new ApplicationError(
        'INVALID_REQUEST',
        '--secret-ref must use key=runtime-secret-ref.',
      );
    }
    assertRuntimeSecretRef(ref);
    refs[key.trim()] = ref.trim();
    index += 1;
  }
  return refs;
}

export function assertRuntimeSecretRef(value: string): void {
  if (/^(gantry-secret|env|aws-sm):[A-Za-z0-9._:@/-]+$/.test(value.trim())) {
    return;
  }
  throw new ApplicationError(
    'INVALID_REQUEST',
    `Provider Account secret values must be runtime secret refs such as ${gantryRuntimeSecretRef('SLACK_BOT_TOKEN')}.`,
  );
}

export function providerAccountIdForAgent(
  settings: {
    providerAccounts: Record<string, { provider: string; agentId: string }>;
  },
  input: {
    providerId: string;
    agentId: string;
    defaultAccountId: string;
  },
): string {
  const existing = Object.entries(settings.providerAccounts).find(
    ([, account]) =>
      account.provider === input.providerId &&
      account.agentId === input.agentId,
  )?.[0];
  if (existing) return existing;
  const defaultAccount = settings.providerAccounts[input.defaultAccountId];
  if (!defaultAccount || defaultAccount.agentId === input.agentId) {
    return input.defaultAccountId;
  }
  const base = `${input.providerId}_${input.agentId}`;
  let candidate = base;
  let suffix = 2;
  while (
    settings.providerAccounts[candidate] &&
    settings.providerAccounts[candidate].agentId !== input.agentId
  ) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

interface ConversationIdSettings {
  providerAccounts: Record<string, { provider: string }>;
  conversations: Record<
    string,
    {
      externalId: string;
      providerAccount?: string;
      providerConnection?: string;
    }
  >;
}

export function storedConversationIdCandidates(
  resolvedConversationId: string,
  providerAccountId: string,
): string[] {
  const accountPrefix = `conversation:${providerAccountId}:`;
  const jid = resolvedConversationId.startsWith(accountPrefix)
    ? resolvedConversationId.slice(accountPrefix.length)
    : resolvedConversationId.replace(/^conversation:/, '');
  return [
    `conversation:${providerAccountId}:${jid}`,
    `conversation:${jid}`,
  ].filter(
    (candidate, index, candidates) => candidates.indexOf(candidate) === index,
  );
}

export function conversationIdFromConfigured(
  settings: ConversationIdSettings,
  configured: ConversationIdSettings['conversations'][string],
): string {
  const providerAccountId =
    configured.providerAccount ?? configured.providerConnection;
  const connection = providerAccountId
    ? settings.providerAccounts[providerAccountId]
    : undefined;
  const provider = connection ? getProvider(connection.provider) : undefined;
  const prefix = provider?.jidPrefix ?? `${connection?.provider ?? ''}:`;
  const externalId = configured.externalId.trim();
  const jid = externalId.startsWith(prefix)
    ? externalId
    : `${prefix}${externalId}`;
  return `conversation:${providerAccountId}:${jid}`;
}

export function soleProviderAccountIdForJid(
  settings: Pick<ConversationIdSettings, 'providerAccounts'>,
  jid: string,
): string | undefined {
  const matches = Object.entries(settings.providerAccounts)
    .filter(([, account]) => {
      const provider = getProvider(account.provider);
      return provider?.jidPrefix ? jid.startsWith(provider.jidPrefix) : false;
    })
    .map(([id]) => id);
  return matches.length === 1 ? matches[0] : undefined;
}
