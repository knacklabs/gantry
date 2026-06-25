import {
  getTriggerPattern,
  MAX_MESSAGES_PER_PROMPT,
  MESSAGE_FETCH_PAGE_SIZE,
  TIMEZONE,
} from '../config/index.js';
import {
  encodeGroupMessageCursor,
  toGroupMessageCursor,
} from '../shared/message-cursor.js';
import { logger } from '../infrastructure/logging/logger.js';
import {
  NewMessage,
  ProgressUpdateOptions,
  ConversationRoute,
} from '../domain/types.js';
import type {
  RuntimeConversationRouteRepository,
  RuntimeMessageRepository,
} from '../domain/repositories/ops-repo.js';
import type { LiveAdmissionWorkItem } from '../domain/ports/live-turns.js';
import { formatMessages } from '../messaging/router.js';
import {
  isSenderControlAllowed,
  isTriggerAllowed,
  loadSenderControlAllowlist,
  loadSenderAllowlist,
} from '../platform/sender-allowlist.js';
import {
  extractSessionCommand,
  isSessionCommandAllowed,
} from '../session/session-commands.js';
import type { SessionCommand } from '../session/session-commands.js';
import {
  makeThreadQueueKey,
  parseThreadQueueKey,
} from '../shared/thread-queue-key.js';
import {
  buildPendingMessagesContinuationIdempotencyKey,
  collectPendingMessagesSince,
} from './pending-message-replay.js';
import { resolveNonSelfSenderIds } from './session-resume-runtime.js';

export interface MessageLoopDeps {
  getConversationRoutes: () => Record<string, ConversationRoute>;
  getOrRecoverCursor: (chatJid: string) => Promise<string> | string;
  setAgentCursor: (chatJid: string, timestamp: string) => void;
  saveState: () => Promise<void> | void;
  hasChannel: (chatJid: string) => boolean;
  setTyping: (chatJid: string, isTyping: boolean) => Promise<void>;
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

function resolveMessageRepository(
  deps: MessageLoopDeps,
): RuntimeMessageRepository & Partial<RuntimeConversationRouteRepository> {
  if (!deps.opsRepository) {
    throw new Error('Message loop requires a runtime message repository');
  }
  return deps.opsRepository;
}

async function resolveConversationRoute(
  deps: MessageLoopDeps,
  chatJid: string,
): Promise<ConversationRoute | undefined> {
  const conversationRoutes = deps.getConversationRoutes();
  const route = conversationRoutes[chatJid];
  if (route) return route;
  const persistedRoute =
    await deps.opsRepository?.getConversationRoute?.(chatJid);
  if (persistedRoute) {
    conversationRoutes[chatJid] = persistedRoute;
  }
  return persistedRoute;
}

function saveStateBestEffort(deps: MessageLoopDeps, chatJid: string): void {
  Promise.resolve(deps.saveState()).catch((err) =>
    logger.warn({ chatJid, err }, 'Failed to persist message cursor state'),
  );
}

async function hasTriggerOwnedThreadRoot(input: {
  opsRepository: RuntimeMessageRepository &
    Partial<RuntimeConversationRouteRepository>;
  chatJid: string;
  threadId: string;
  group: ConversationRoute;
  triggerPattern: RegExp;
}): Promise<boolean> {
  const rootCandidates = await input.opsRepository.getMessagesSince(
    input.chatJid,
    '',
    MESSAGE_FETCH_PAGE_SIZE,
    { threadId: input.threadId },
  );
  if (rootCandidates.length === 0) return false;

  const allowlistCfg = loadSenderAllowlist();
  return rootCandidates.some(
    (message) =>
      message.thread_id === input.threadId &&
      !message.reply_to_message_id &&
      input.triggerPattern.test(message.content.trim()) &&
      (message.is_from_me ||
        isTriggerAllowed(
          input.chatJid,
          message.sender,
          allowlistCfg,
          input.group.folder,
        )),
  );
}

async function enqueueMessageCheck(
  deps: MessageLoopDeps,
  queueJid: string,
): Promise<MessageAdmissionProcessingResult> {
  const accepted = await deps.queue.enqueueMessageCheck(queueJid);
  return accepted === false ? 'queued_capacity' : 'completed';
}

async function processQueueMessages(
  deps: MessageLoopDeps,
  queueJid: string,
  groupMessages: NewMessage[],
  preloadedInitialReplay?: {
    messages: NewMessage[];
    hasMore: boolean;
    cursorAfter: string | null;
  },
): Promise<MessageAdmissionProcessingResult> {
  const opsRepository = resolveMessageRepository(deps);
  const { chatJid, threadId } = parseThreadQueueKey(queueJid);
  const group = await resolveConversationRoute(deps, chatJid);
  if (!group) return 'listener_degraded';

  if (!deps.hasChannel(chatJid)) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return 'listener_degraded';
  }

  const triggerPattern = getTriggerPattern(group.trigger);
  const loopCmdMsg = groupMessages.find(
    (m) => extractSessionCommand(m.content, triggerPattern) !== null,
  );
  const recoveredCursor = await deps.getOrRecoverCursor(queueJid);

  if (loopCmdMsg) {
    const loopCommand = extractSessionCommand(
      loopCmdMsg.content,
      triggerPattern,
    );
    const controlAllowlistCfg = loadSenderControlAllowlist();
    if (
      isSessionCommandAllowed(
        loopCmdMsg.is_from_me === true,
        isSenderControlAllowed(
          chatJid,
          loopCmdMsg.sender,
          controlAllowlistCfg,
          group.folder,
        ),
      )
    ) {
      if (loopCommand && deps.handleActiveControlCommand) {
        const handled = await deps.handleActiveControlCommand({
          chatJid,
          queueJid,
          group,
          message: loopCmdMsg,
          command: loopCommand,
        });
        if (handled) {
          if (preloadedInitialReplay?.hasMore) {
            return enqueueMessageCheck(deps, queueJid);
          }
          return 'completed';
        }
      }
      if (loopCommand?.kind === 'stop') {
        await deps.queue.stopGroup?.(queueJid);
      } else {
        await deps.queue.closeStdin(queueJid);
      }
    }
    return enqueueMessageCheck(deps, queueJid);
  }

  const replay =
    preloadedInitialReplay ??
    (await collectPendingMessagesSince({
      getMessagesSince: opsRepository.getMessagesSince.bind(opsRepository),
      chatJid,
      sinceCursor: recoveredCursor,
      pageSize: MESSAGE_FETCH_PAGE_SIZE,
      maxMessages: MAX_MESSAGES_PER_PROMPT,
      options: { threadId: threadId ?? null },
    }));
  let initialBatch = replay.messages;
  if (initialBatch.length === 0) {
    initialBatch = groupMessages;
  }

  const needsTrigger = group.requiresTrigger !== false;
  if (needsTrigger) {
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = initialBatch.some(
      (m) =>
        triggerPattern.test(m.content.trim()) &&
        (m.is_from_me ||
          isTriggerAllowed(chatJid, m.sender, allowlistCfg, group.folder)),
    );
    const isContinuationThread =
      threadId !== undefined &&
      recoveredCursor.trim().length > 0 &&
      (await hasTriggerOwnedThreadRoot({
        opsRepository,
        chatJid,
        threadId,
        group,
        triggerPattern,
      }));
    if (!hasTrigger && !isContinuationThread) {
      const lastMessage = initialBatch[initialBatch.length - 1];
      const cursorAfter = replay.cursorAfter
        ? replay.cursorAfter
        : lastMessage
          ? encodeGroupMessageCursor(toGroupMessageCursor(lastMessage))
          : null;
      if (cursorAfter) {
        deps.setAgentCursor(queueJid, cursorAfter);
        saveStateBestEffort(deps, chatJid);
      }
      if (replay.hasMore) {
        return enqueueMessageCheck(deps, queueJid);
      }
      return 'completed';
    }
  }

  if (initialBatch.length === 0) return 'completed';

  const formatted = formatMessages(initialBatch, TIMEZONE);
  const senderUserIds = resolveNonSelfSenderIds(initialBatch);
  const cursorAfter = encodeGroupMessageCursor(
    toGroupMessageCursor(initialBatch[initialBatch.length - 1]),
  );

  if (
    !(await deps.queue.sendMessage(queueJid, formatted, {
      threadId,
      senderUserIds,
      idempotencyKey: buildPendingMessagesContinuationIdempotencyKey({
        queueJid,
        sinceCursor: recoveredCursor,
        cursorAfter,
        messages: initialBatch,
      }),
      cursorAfter,
    }))
  ) {
    return enqueueMessageCheck(deps, queueJid);
  }

  logger.debug(
    { chatJid, count: initialBatch.length },
    'Piped messages to active agent run',
  );
  deps.setAgentCursor(queueJid, cursorAfter);
  saveStateBestEffort(deps, chatJid);
  if (replay.hasMore) {
    return enqueueMessageCheck(deps, queueJid);
  }
  deps
    .setTyping(chatJid, true)
    .catch((err: unknown) =>
      logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
    );
  return 'completed';
}

export async function processLiveAdmissionWorkItem(
  deps: MessageLoopDeps,
  item: LiveAdmissionWorkItem,
): Promise<MessageAdmissionProcessingResult> {
  const opsRepository = resolveMessageRepository(deps);
  const { chatJid, threadId } = parseThreadQueueKey(item.queueJid);
  if (
    chatJid !== item.conversationId ||
    (threadId ?? null) !== (item.threadId ?? null)
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

  const recoveredCursor = await deps.getOrRecoverCursor(item.queueJid);
  const replay = await collectPendingMessagesSince({
    getMessagesSince: opsRepository.getMessagesSince.bind(opsRepository),
    chatJid,
    sinceCursor: recoveredCursor,
    pageSize: MESSAGE_FETCH_PAGE_SIZE,
    maxMessages: MAX_MESSAGES_PER_PROMPT,
    options: { threadId: threadId ?? null },
  });
  const messages = replay.messages;
  if (messages.length === 0) return 'completed';
  return processQueueMessages(deps, item.queueJid, messages, replay);
}

export async function recoverPendingMessages(
  deps: MessageLoopDeps,
): Promise<void> {
  const opsRepository = resolveMessageRepository(deps);
  for (const [chatJid, group] of Object.entries(deps.getConversationRoutes())) {
    const queuedThreads = new Set<string>();
    let pendingCount = 0;

    for (const threadId of await opsRepository.getMessageThreadIds(chatJid)) {
      const queueJid = makeThreadQueueKey(chatJid, threadId);
      const pending = await collectPendingMessagesSince({
        getMessagesSince: opsRepository.getMessagesSince.bind(opsRepository),
        chatJid,
        sinceCursor: await deps.getOrRecoverCursor(queueJid),
        pageSize: MESSAGE_FETCH_PAGE_SIZE,
        options: { threadId },
      });
      if (pending.messages.length > 0) {
        pendingCount += pending.messages.length;
        queuedThreads.add(queueJid);
      }
    }

    if (pendingCount === 0) continue;

    logger.info(
      { group: group.name, pendingCount },
      'Recovery: found unprocessed messages',
    );
    for (const queueJid of queuedThreads) {
      deps.queue.enqueueMessageCheck(queueJid);
    }
  }
}
