import { logger } from '../infrastructure/logging/logger.js';
import {
  NewMessage,
  ProgressUpdateOptions,
  ConversationRoute,
} from '../domain/types.js';
import { agentIdForFolder } from '../domain/agent/agent-folder-id.js';
import type {
  RuntimeConversationRouteRepository,
  RuntimeMessageRepository,
} from '../domain/repositories/ops-repo.js';
import type {
  LiveAdmissionWorkItem,
  LiveAdmissionWorkItemRepository,
} from '../domain/ports/live-turns.js';
import type { SessionCommand } from '../session/session-commands.js';
import {
  makeAgentThreadQueueKey,
  normalizeThreadQueueId,
  parseAgentThreadQueueKey,
} from '../shared/thread-queue-key.js';

export interface MessageLoopDeps {
  appId?: string;
  inputRepository?: Pick<
    LiveAdmissionWorkItemRepository,
    'listUnconsumedLiveAdmissionQueueJids'
  >;
  getConversationRoutes: () => Record<string, ConversationRoute>;
  getOrRecoverCursor: (chatJid: string) => Promise<string> | string;
  setAgentCursor: (chatJid: string, timestamp: string) => void;
  saveState: () => Promise<void> | void;
  hasChannel: (
    chatJid: string,
    options?: { providerAccountId?: string; threadId?: string },
  ) => boolean;
  setTyping: (
    chatJid: string,
    isTyping: boolean,
    options?: { providerAccountId?: string; threadId?: string },
  ) => Promise<void>;
  sendProgressUpdate: (
    chatJid: string,
    text: string,
    options?: ProgressUpdateOptions,
  ) => Promise<void>;
  queue: {
    sendMessage: (
      chatJid: string,
      text: string,
      options?: {
        threadId?: string | null;
        senderUserIds?: readonly string[] | null;
        idempotencyKey?: string;
        cursorAfter?: string;
      },
    ) => boolean | Promise<boolean>;
    enqueueMessageCheck: (
      chatJid: string,
    ) => void | boolean | Promise<void | boolean>;
    closeStdin: (chatJid: string) => void | Promise<void>;
    stopGroup?: (chatJid: string) => boolean | Promise<boolean>;
  };
  handleActiveControlCommand?: (args: {
    chatJid: string;
    queueJid: string;
    group: ConversationRoute;
    message: NewMessage;
    command: SessionCommand;
  }) => Promise<boolean> | boolean;
  opsRepository?: RuntimeMessageRepository &
    Partial<RuntimeConversationRouteRepository>;
}

export type MessageAdmissionProcessingResult =
  | 'completed'
  | 'queued_capacity'
  | 'listener_degraded';

async function resolveConversationRoute(
  deps: MessageLoopDeps,
  chatJid: string,
  agentId?: string | null,
  threadId?: string | null,
  providerAccountId?: string | null,
): Promise<ConversationRoute | undefined> {
  const conversationRoutes = deps.getConversationRoutes();
  const selectedAgentId = agentId ? agentIdForFolder(agentId) : null;
  const selectedRoute = selectConversationRouteEntry(
    conversationRoutes,
    chatJid,
    selectedAgentId,
    threadId,
    providerAccountId,
  );
  if (selectedRoute) return selectedRoute[1];

  for (const routeKey of persistedRouteLookupKeys(
    chatJid,
    selectedAgentId,
    threadId,
    providerAccountId,
  )) {
    const persistedRoute =
      await deps.opsRepository?.getConversationRoute?.(routeKey);
    if (
      persistedRoute &&
      (!selectedAgentId ||
        agentIdForFolder(persistedRoute.folder) === selectedAgentId)
    ) {
      const persistedKey = parseAgentThreadQueueKey(routeKey);
      conversationRoutes[routeKey] = persistedRoute;
      const canonicalRouteKey = makeAgentThreadQueueKey(
        persistedKey.chatJid,
        agentIdForFolder(persistedRoute.folder),
        persistedKey.threadId,
        persistedKey.providerAccountId,
      );
      conversationRoutes[canonicalRouteKey] = persistedRoute;
      return persistedRoute;
    }
  }
  return undefined;
}

function selectConversationRouteEntry(
  conversationRoutes: Record<string, ConversationRoute>,
  chatJid: string,
  selectedAgentId?: string | null,
  threadId?: string | null,
  providerAccountId?: string | null,
): [string, ConversationRoute] | undefined {
  const requestedThreadId = normalizeThreadQueueId(threadId);
  const requestedProviderAccountId = providerAccountId?.trim();
  const exactThreadRoutes: Array<[string, ConversationRoute]> = [];
  const wholeConversationRoutes: Array<[string, ConversationRoute]> = [];

  for (const entry of Object.entries(conversationRoutes)) {
    const [key, route] = entry;
    const parsed = parseAgentThreadQueueKey(key);
    if (parsed.chatJid !== chatJid) continue;
    if (
      requestedProviderAccountId &&
      route.providerAccountId !== requestedProviderAccountId
    ) {
      continue;
    }
    if (selectedAgentId && agentIdForFolder(route.folder) !== selectedAgentId) {
      continue;
    }
    if (parsed.threadId) {
      if (requestedThreadId && parsed.threadId === requestedThreadId) {
        exactThreadRoutes.push(entry);
      }
      continue;
    }
    wholeConversationRoutes.push(entry);
  }

  return preferAgentQualifiedRoute(
    requestedThreadId && exactThreadRoutes.length > 0
      ? exactThreadRoutes
      : wholeConversationRoutes,
  );
}

function preferAgentQualifiedRoute(
  routes: Array<[string, ConversationRoute]>,
): [string, ConversationRoute] | undefined {
  let fallback: [string, ConversationRoute] | undefined;
  for (const entry of routes) {
    if (parseAgentThreadQueueKey(entry[0]).agentId) return entry;
    fallback ??= entry;
  }
  return fallback;
}

function persistedRouteLookupKeys(
  chatJid: string,
  selectedAgentId?: string | null,
  threadId?: string | null,
  providerAccountId?: string | null,
): string[] {
  const keys: string[] = [];
  if (selectedAgentId && normalizeThreadQueueId(threadId)) {
    keys.push(
      makeAgentThreadQueueKey(
        chatJid,
        selectedAgentId,
        threadId,
        providerAccountId,
      ),
    );
  }
  if (normalizeThreadQueueId(threadId)) {
    keys.push(
      makeAgentThreadQueueKey(chatJid, null, threadId, providerAccountId),
    );
  }
  if (selectedAgentId) {
    keys.push(
      makeAgentThreadQueueKey(
        chatJid,
        selectedAgentId,
        null,
        providerAccountId,
      ),
    );
  }
  keys.push(makeAgentThreadQueueKey(chatJid, null, null, providerAccountId));
  return [...new Set(keys)];
}

async function enqueueMessageCheck(
  deps: MessageLoopDeps,
  queueJid: string,
): Promise<MessageAdmissionProcessingResult> {
  const accepted = await deps.queue.enqueueMessageCheck(queueJid);
  return accepted === false ? 'queued_capacity' : 'completed';
}

export async function processLiveAdmissionWorkItem(
  deps: MessageLoopDeps,
  item: LiveAdmissionWorkItem,
): Promise<MessageAdmissionProcessingResult> {
  const { chatJid, threadId, agentId, providerAccountId } =
    parseAgentThreadQueueKey(item.queueJid);
  const parsedAgentId = agentId ? agentIdForFolder(agentId) : null;
  const itemAgentId = item.agentId ? agentIdForFolder(item.agentId) : null;
  if (
    chatJid !== item.conversationId ||
    (threadId ?? null) !== (item.threadId ?? null) ||
    parsedAgentId !== itemAgentId
  ) {
    logger.warn(
      {
        itemId: item.id,
        queueJid: item.queueJid,
        conversationId: item.conversationId,
        threadId: item.threadId,
      },
      'Live admission work item queue identity mismatch',
    );
    return 'listener_degraded';
  }

  const group = await resolveConversationRoute(
    deps,
    chatJid,
    agentId,
    threadId,
    providerAccountId,
  );
  if (
    !group ||
    !deps.hasChannel(chatJid, { providerAccountId: group.providerAccountId })
  ) {
    return 'listener_degraded';
  }
  return enqueueMessageCheck(deps, item.queueJid);
}

export async function recoverPendingMessages(
  deps: MessageLoopDeps,
): Promise<void> {
  if (!deps.appId || !deps.inputRepository) {
    throw new Error(
      'Pending message recovery requires the admission repository',
    );
  }
  const queueJids =
    await deps.inputRepository.listUnconsumedLiveAdmissionQueueJids({
      appId: deps.appId,
    });
  for (const queueJid of queueJids) {
    await deps.queue.enqueueMessageCheck(queueJid);
  }
}
