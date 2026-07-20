import type { ConversationRoute } from '../domain/types.js';
import { parseAgentThreadQueueKey } from '../shared/thread-queue-key.js';

export function resolveRunnerIpcRoute(input: {
  routes: Record<string, ConversationRoute>;
  sourceAgentFolder: string;
  targetJid?: string;
  threadId?: string;
  providerAccountId?: string;
}): {
  targetJid: string;
  conversationId?: string;
  providerAccountId?: string;
} {
  const requestedProviderAccountId = input.providerAccountId?.trim();
  const matches = Object.entries(input.routes)
    .map(([key, route]) => {
      const parsed = parseAgentThreadQueueKey(key);
      const providerAccountId =
        parsed.providerAccountId ?? route.providerAccountId?.trim();
      return { parsed, route, providerAccountId };
    })
    .filter(({ parsed, route, providerAccountId }) => {
      if (route.folder !== input.sourceAgentFolder) return false;
      if (input.targetJid && parsed.chatJid !== input.targetJid) return false;
      if (parsed.threadId && parsed.threadId !== input.threadId) return false;
      return (
        !requestedProviderAccountId ||
        providerAccountId === requestedProviderAccountId
      );
    });

  const exactThread = input.threadId
    ? matches.filter(({ parsed }) => parsed.threadId === input.threadId)
    : [];
  const candidates = exactThread.length > 0 ? exactThread : matches;
  const distinctIdentities = (items: typeof candidates): Set<string> =>
    new Set(
      items.map(
        ({ parsed, route, providerAccountId }) =>
          `${parsed.chatJid}::${route.conversationId ?? ''}::${providerAccountId ?? ''}`,
      ),
    );
  let selected = candidates;
  // Stale duplicate aliases (a bare `conversation:<chat>` key and an
  // explicitly provider-account-qualified key) can carry divergent
  // conversationIds and make the identity set look ambiguous. When the request
  // names a provider account, prefer the explicitly-qualified route keys before
  // failing closed, so those stale aliases don't block a well-formed request.
  if (distinctIdentities(selected).size > 1 && requestedProviderAccountId) {
    const qualified = selected.filter(
      ({ parsed }) => parsed.providerAccountId === requestedProviderAccountId,
    );
    if (qualified.length > 0 && distinctIdentities(qualified).size === 1) {
      selected = qualified;
    }
  }
  if (distinctIdentities(selected).size !== 1) {
    throw new Error('Runner IPC route is ambiguous or unauthorized');
  }
  const match = selected[0]!;
  if (
    requestedProviderAccountId &&
    match.providerAccountId !== requestedProviderAccountId
  ) {
    throw new Error('Runner IPC provider account does not match route');
  }
  return {
    targetJid: match.parsed.chatJid,
    ...(match.route.conversationId
      ? { conversationId: match.route.conversationId }
      : {}),
    ...(match.providerAccountId
      ? { providerAccountId: match.providerAccountId }
      : {}),
  };
}
