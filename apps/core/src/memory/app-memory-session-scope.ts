import type { AgentSession } from '../domain/sessions/sessions.js';

const CONVERSATION_ID_PREFIX = 'conversation:';

export function parseSessionScopeKey(input: { session: AgentSession }): {
  isScopeKey: boolean;
  groupId?: string;
} {
  const raw = input.session.userId?.trim();
  if (!raw) return { isScopeKey: false };
  const parts = raw.split('::');
  if (parts.length > 1) {
    const groupId = decodeSessionScopeComponent(parts[0]?.trim() ?? '');
    if (groupId) return { isScopeKey: true, groupId };
  }
  if (input.session.agentId === `agent:${raw}`) {
    return { isScopeKey: true, groupId: raw };
  }
  return { isScopeKey: false };
}

function decodeSessionScopeComponent(value: string): string {
  if (!value) return '';
  try {
    return decodeURIComponent(value).trim();
  } catch {
    return value.trim();
  }
}

export function conversationJidFromSession(
  session: AgentSession,
): string | undefined {
  const id = session.conversationId?.trim();
  if (!id || !id.startsWith(CONVERSATION_ID_PREFIX)) return undefined;
  const raw = id.slice(CONVERSATION_ID_PREFIX.length).trim();
  const jid = liveConversationJidFromCanonicalSuffix(raw);
  return jid || undefined;
}

function liveConversationJidFromCanonicalSuffix(value: string): string {
  const parts = value.split(':');
  if (parts.length < 3) return value;
  if (parts[0] === 'channel-providerAccount' && parts.length > 3) {
    // The marker account id is ALWAYS exactly three segments —
    // `channel-providerAccount:<appId>:<providerId>` (fallbackProviderAccountId
    // in channels/provider-registry.ts) — and appId/providerId are validated
    // colon-free, so the jid deterministically starts at segment 3. A review
    // suggested scanning for a variable segment count; that would misparse
    // provider-word segments as jid schemes.
    const candidate = parts.slice(3).join(':').trim();
    return looksLikeLiveConversationJid(candidate) ? candidate : value;
  }
  // A suffix whose first segment is a real channel scheme IS the jid:
  // `app:app-one:conv-1` must survive whole, while the account-qualified
  // `acct_default:sl:C123` must strip to `sl:C123`. The loose jid regex
  // cannot tell those apart, so the discriminator is the closed set of
  // built-in live jid schemes (review finding, 2026-08-01).
  if (LIVE_JID_SCHEMES.has(parts[0] ?? '')) return value;
  const candidate = parts.slice(1).join(':').trim();
  return looksLikeLiveConversationJid(candidate) ? candidate : value;
}

const LIVE_JID_SCHEMES = new Set(['app', 'sl', 'tg', 'dc', 'teams']);

function looksLikeLiveConversationJid(value: string): boolean {
  return /^[a-z][a-z0-9_-]{1,31}:.+$/i.test(value);
}
