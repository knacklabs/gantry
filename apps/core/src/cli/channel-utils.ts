import '../channels/register-builtins.js';
import {
  listChannelProviders,
  providerForJid,
} from '../channels/provider-registry.js';
import { RuntimeChannel } from './runtime-settings.js';

export function getChannelIds(): RuntimeChannel[] {
  return listChannelProviders().map((provider) => provider.id);
}

export function parseRuntimeChannel(raw: string): RuntimeChannel | null {
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return null;
  if (getChannelIds().includes(normalized)) {
    return normalized;
  }
  for (const provider of listChannelProviders()) {
    const shortPrefix = provider.jidPrefix.replace(/:$/, '').toLowerCase();
    if (normalized === shortPrefix) {
      return provider.id;
    }
  }
  return null;
}

export function channelFromGroupJid(jid: string): RuntimeChannel | null {
  return providerForJid(jid)?.id ?? null;
}
