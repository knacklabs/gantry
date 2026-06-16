import { CANONICAL_APP_ID } from './canonical-graph-repository.postgres.js';
import { appIdFromConversationJid } from '../../../../shared/app-conversation-jid.js';

export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

export function makeOwnedAgentSessionScopeKey(
  agentId: string,
  routeScopeKey: string,
  appId = CANONICAL_APP_ID,
): string {
  const agentScope = `agent:${encodeURIComponent(agentId)}::${routeScopeKey}`;
  if (appId === CANONICAL_APP_ID) return agentScope;
  return `app:${encodeURIComponent(appId)}::${agentScope}`;
}

export function makeOwnedAgentSessionId(
  agentId: string,
  routeScopeKey: string,
  appId = CANONICAL_APP_ID,
): string {
  return `agent-session:${makeOwnedAgentSessionScopeKey(agentId, routeScopeKey, appId)}`;
}

function isScopedSessionKey(scopeKey: string): boolean {
  return /::(?:conversation|user|thread):/.test(scopeKey);
}

export function buildCurrentScopeResetMatcher(scopeKey: string): {
  currentScopeExact: string;
  currentScopeDescendantLike?: string;
} {
  const escapedScopeKey = escapeLikePattern(scopeKey);
  const includeDescendants = !isScopedSessionKey(scopeKey);
  return {
    currentScopeExact: scopeKey,
    ...(includeDescendants
      ? {
          currentScopeDescendantLike: `${escapedScopeKey}::%`,
        }
      : {}),
  };
}

export function conversationKindInput(kind?: 'dm' | 'channel'): {
  isGroup?: boolean;
} {
  if (kind === 'channel') return { isGroup: true };
  if (kind === 'dm') return { isGroup: false };
  return {};
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stringMetadataValue(
  metadata: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function providerSessionContext(providerSession: {
  id: string;
  externalSessionId: string;
  metadataJson: unknown;
}): {
  providerSessionId: string;
  externalSessionId: string;
  providerSessionAccessFingerprint?: string;
} {
  const accessFingerprint = stringMetadataValue(
    parseJsonRecord(providerSession.metadataJson),
    'accessFingerprint',
  );
  return {
    providerSessionId: providerSession.id,
    externalSessionId: providerSession.externalSessionId,
    ...(accessFingerprint
      ? { providerSessionAccessFingerprint: accessFingerprint }
      : {}),
  };
}

export function resolveSessionAppId(input: {
  appId?: string | null;
  chatJid?: string | null;
}): string {
  return (
    input.appId?.trim() ||
    (input.chatJid ? appIdFromConversationJid(input.chatJid) : null) ||
    CANONICAL_APP_ID
  );
}
