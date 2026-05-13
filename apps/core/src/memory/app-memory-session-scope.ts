import type { AgentSession } from '../domain/sessions/sessions.js';

const CONVERSATION_ID_PREFIX = 'conversation:';
const THREAD_ID_PREFIX = 'thread:';

export function parseSessionScopeKey(input: { session: AgentSession }): {
  isScopeKey: boolean;
  groupId?: string;
  threadId?: string;
} {
  const raw = input.session.userId?.trim();
  if (!raw) return { isScopeKey: false };
  const parts = raw.split('::');
  if (parts.length > 1) {
    const groupId = decodeSessionScopeComponent(parts[0]?.trim() ?? '');
    const threadPart = parts.find((part) => part.startsWith('thread:'));
    const threadId = threadPart
      ? decodeSessionScopeComponent(threadPart.slice('thread:'.length).trim())
      : undefined;
    if (groupId) return { isScopeKey: true, groupId, threadId };
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
  const jid = id.slice(CONVERSATION_ID_PREFIX.length).trim();
  return jid || undefined;
}

export function rawThreadIdFromSession(
  session: AgentSession,
): string | undefined {
  const scope = parseSessionScopeKey({ session });
  if (scope.threadId) return scope.threadId;
  const canonicalThreadId = session.threadId?.trim();
  const conversationJid = conversationJidFromSession(session);
  if (!canonicalThreadId || !conversationJid) return undefined;
  const prefix = `${THREAD_ID_PREFIX}${conversationJid}:`;
  if (!canonicalThreadId.startsWith(prefix)) return undefined;
  const rawThreadId = canonicalThreadId.slice(prefix.length).trim();
  return rawThreadId || undefined;
}
