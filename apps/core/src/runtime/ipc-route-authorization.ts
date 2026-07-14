import type { ConversationRoute } from '../domain/types.js';
import { parseAgentThreadQueueKey } from '../shared/thread-queue-key.js';

export function resolveRunnerIpcRoute(input: {
  routes: Record<string, ConversationRoute>;
  sourceAgentFolder: string;
  targetJid?: string;
  threadId?: string;
  providerAccountId?: string;
}): { targetJid: string; providerAccountId?: string } {
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
  const identities = new Set(
    candidates.map(
      ({ parsed, providerAccountId }) =>
        `${parsed.chatJid}::${providerAccountId ?? ''}`,
    ),
  );
  if (identities.size !== 1) {
    throw new Error('Runner IPC route is ambiguous or unauthorized');
  }
  const match = candidates[0]!;
  if (
    requestedProviderAccountId &&
    match.providerAccountId !== requestedProviderAccountId
  ) {
    throw new Error('Runner IPC provider account does not match route');
  }
  return {
    targetJid: match.parsed.chatJid,
    ...(match.providerAccountId
      ? { providerAccountId: match.providerAccountId }
      : {}),
  };
}
