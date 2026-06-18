import {
  getTriggerPattern,
  MAX_MESSAGES_PER_PROMPT,
  POLL_INTERVAL,
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
import type { RuntimeMessageRepository } from '../domain/repositories/ops-repo.js';
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
import { resolveNonSelfSenderIds } from './session-resume-runtime.js';

export interface MessageLoopDeps {
  getConversationRoutes: () => Record<string, ConversationRoute>;
  getLastTimestamp: () => string;
  setLastTimestamp: (timestamp: string) => void;
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
    enqueueMessageCheck: (chatJid: string) => void;
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
  opsRepository?: RuntimeMessageRepository;
}

function resolveMessageRepository(
  deps: MessageLoopDeps,
): RuntimeMessageRepository {
  if (!deps.opsRepository) {
    throw new Error('Message loop requires a runtime message repository');
  }
  return deps.opsRepository;
}

function saveStateBestEffort(deps: MessageLoopDeps, chatJid: string): void {
  Promise.resolve(deps.saveState()).catch((err) =>
    logger.warn({ chatJid, err }, 'Failed to persist message cursor state'),
  );
}

export async function runMessagePollingTick(
  deps: MessageLoopDeps,
): Promise<void> {
  try {
    const opsRepository = resolveMessageRepository(deps);
    const conversationRoutes = deps.getConversationRoutes();
    const jids = Object.keys(conversationRoutes);
    const lastTimestamp = deps.getLastTimestamp();
    const { messages, newTimestamp } = await opsRepository.getNewMessages(
      jids,
      lastTimestamp,
    );

    if (newTimestamp !== lastTimestamp) {
      deps.setLastTimestamp(newTimestamp);
      if (messages.length > 0) {
        await deps.saveState();
      } else {
        saveStateBestEffort(deps, '*');
      }
    }

    if (messages.length > 0) {
      logger.info({ count: messages.length }, 'New messages');

      const messagesByGroup = new Map<string, NewMessage[]>();
      for (const msg of messages) {
        const queueJid = makeThreadQueueKey(msg.chat_jid, msg.thread_id);
        const existing = messagesByGroup.get(queueJid);
        if (existing) {
          existing.push(msg);
        } else {
          messagesByGroup.set(queueJid, [msg]);
        }
      }

      for (const [queueJid, groupMessages] of messagesByGroup) {
        const { chatJid, threadId } = parseThreadQueueKey(queueJid);
        const group = conversationRoutes[chatJid];
        if (!group) continue;

        if (!deps.hasChannel(chatJid)) {
          logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
          continue;
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
                continue;
              }
            }
            if (loopCommand?.kind === 'stop') {
              await deps.queue.stopGroup?.(queueJid);
            } else {
              await deps.queue.closeStdin(queueJid);
            }
          }
          deps.queue.enqueueMessageCheck(queueJid);
          continue;
        }

        const needsTrigger = group.requiresTrigger !== false;
        if (needsTrigger) {
          const allowlistCfg = loadSenderAllowlist();
          const hasTrigger = groupMessages.some(
            (m) =>
              triggerPattern.test(m.content.trim()) &&
              (m.is_from_me ||
                isTriggerAllowed(
                  chatJid,
                  m.sender,
                  allowlistCfg,
                  group.folder,
                )),
          );
          const isContinuationThread =
            threadId !== undefined && recoveredCursor.trim().length > 0;
          if (!hasTrigger && !isContinuationThread) continue;
        }

        let initialBatch = await opsRepository.getMessagesSince(
          chatJid,
          recoveredCursor,
          MAX_MESSAGES_PER_PROMPT,
          { threadId: threadId ?? null },
        );
        if (initialBatch.length === 0) {
          initialBatch = groupMessages;
        }

        let pipedAny = false;
        let shouldEnqueueMessageCheck = false;
        let nextBatch: NewMessage[] | null = initialBatch;

        while (nextBatch && nextBatch.length > 0) {
          const messagesToSend = nextBatch;
          const formatted = formatMessages(messagesToSend, TIMEZONE);
          const senderUserIds = resolveNonSelfSenderIds(messagesToSend);

          if (
            !(await deps.queue.sendMessage(queueJid, formatted, {
              threadId,
              senderUserIds,
              idempotencyKey: `continuation:${queueJid}:${messagesToSend
                .map((message) => message.id)
                .join(',')}`,
              cursorAfter: encodeGroupMessageCursor(
                toGroupMessageCursor(messagesToSend[messagesToSend.length - 1]),
              ),
            }))
          ) {
            shouldEnqueueMessageCheck = true;
            break;
          }

          pipedAny = true;
          logger.debug(
            { chatJid, count: messagesToSend.length },
            'Piped messages to active agent run',
          );
          deps.setAgentCursor(
            queueJid,
            encodeGroupMessageCursor(
              toGroupMessageCursor(messagesToSend[messagesToSend.length - 1]),
            ),
          );
          saveStateBestEffort(deps, chatJid);

          if (messagesToSend.length < MAX_MESSAGES_PER_PROMPT) {
            break;
          }

          nextBatch = await opsRepository.getMessagesSince(
            chatJid,
            await deps.getOrRecoverCursor(queueJid),
            MAX_MESSAGES_PER_PROMPT,
            { threadId: threadId ?? null },
          );
        }

        if (pipedAny) {
          deps
            .setTyping(chatJid, true)
            .catch((err: unknown) =>
              logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
            );
        }

        if (!pipedAny || shouldEnqueueMessageCheck) {
          deps.queue.enqueueMessageCheck(queueJid);
        }
      }
    }
  } catch (err) {
    logger.error({ err }, 'Error in message loop');
  }
}

export interface MessagePollingLoopHandle {
  /** Stop the loop after the in-flight tick; cancels the pending poll delay. */
  stop: () => void;
  /** Settles when the loop exits (only rejects on an unexpected crash). */
  done: Promise<void>;
}

/**
 * Start the live message polling loop. The loop runs on EVERY live-capable
 * worker (distributed admission); it is not gated by any lease. Duplicate run
 * admission across the fleet is prevented downstream by the durable
 * per-scope claim (`uq_live_turns_active_scope`) plus idempotent continuation
 * commands — the losing poller routes its message to the durable owner instead
 * of starting a second run. Role gating happens in the bootstrap caller
 * (runtime-services gates this loop on `liveExecution`). The returned handle
 * stops the loop for graceful drain.
 */
export function startMessagePollingLoop(
  deps: MessageLoopDeps,
): MessagePollingLoopHandle {
  let stopped = false;
  let cancelDelay: (() => void) | undefined;
  const done = (async () => {
    while (!stopped) {
      await runMessagePollingTick(deps);
      if (stopped) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          cancelDelay = undefined;
          resolve();
        }, POLL_INTERVAL);
        cancelDelay = () => {
          cancelDelay = undefined;
          clearTimeout(timer);
          resolve();
        };
      });
    }
  })();
  return {
    stop: () => {
      stopped = true;
      cancelDelay?.();
    },
    done,
  };
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
      const pending = await opsRepository.getMessagesSince(
        chatJid,
        await deps.getOrRecoverCursor(queueJid),
        MAX_MESSAGES_PER_PROMPT,
        { threadId },
      );
      if (pending.length > 0) {
        pendingCount += pending.length;
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
