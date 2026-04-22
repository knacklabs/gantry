import {
  getTriggerPattern,
  MAX_MESSAGES_PER_PROMPT,
  POLL_INTERVAL,
  TIMEZONE,
} from '../core/config.js';
import {
  encodeGroupMessageCursor,
  toGroupMessageCursor,
} from '../core/message-cursor.js';
import { logger } from '../core/logger.js';
import {
  NewMessage,
  ProgressUpdateOptions,
  RegisteredGroup,
} from '../core/types.js';
import {
  getMessagesSince,
  getMessageThreadIds,
  getNewMessages,
} from '../storage/db.js';
import { formatMessages } from '../messaging/router.js';
import {
  isSenderExplicitlyAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
} from '../platform/sender-allowlist.js';
import {
  extractSessionCommand,
  isSessionCommandAllowed,
} from '../session/session-commands.js';
import type { SessionCommand } from '../session/session-commands.js';
import {
  makeThreadQueueKey,
  normalizeThreadQueueId,
  parseThreadQueueKey,
} from './thread-queue-key.js';

export interface MessageLoopDeps {
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  getLastTimestamp: () => string;
  setLastTimestamp: (timestamp: string) => void;
  getOrRecoverCursor: (chatJid: string) => string;
  setAgentCursor: (chatJid: string, timestamp: string) => void;
  saveState: () => void;
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
      options?: { threadId?: string | null },
    ) => boolean;
    enqueueMessageCheck: (chatJid: string) => void;
    closeStdin: (chatJid: string) => void;
    stopGroup?: (chatJid: string) => boolean;
  };
  handleActiveControlCommand?: (args: {
    chatJid: string;
    queueJid: string;
    group: RegisteredGroup;
    message: NewMessage;
    command: SessionCommand;
  }) => Promise<boolean> | boolean;
}

export async function runMessagePollingTick(
  deps: MessageLoopDeps,
): Promise<void> {
  try {
    const registeredGroups = deps.getRegisteredGroups();
    const jids = Object.keys(registeredGroups);
    const { messages, newTimestamp } = getNewMessages(
      jids,
      deps.getLastTimestamp(),
    );

    if (messages.length > 0) {
      logger.info({ count: messages.length }, 'New messages');

      deps.setLastTimestamp(newTimestamp);
      deps.saveState();

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
        const group = registeredGroups[chatJid];
        if (!group) continue;

        if (!deps.hasChannel(chatJid)) {
          logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
          continue;
        }

        const isMainGroup = group.isMain === true;

        const triggerPattern = getTriggerPattern(group.trigger);
        const loopCmdMsg = groupMessages.find(
          (m) => extractSessionCommand(m.content, triggerPattern) !== null,
        );

        if (loopCmdMsg) {
          const loopCommand = extractSessionCommand(
            loopCmdMsg.content,
            triggerPattern,
          );
          const allowlistCfg = loadSenderAllowlist();
          if (
            isSessionCommandAllowed(
              loopCmdMsg.is_from_me === true,
              isSenderExplicitlyAllowed(
                chatJid,
                loopCmdMsg.sender,
                allowlistCfg,
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
              deps.queue.stopGroup?.(queueJid);
            } else {
              deps.queue.closeStdin(queueJid);
            }
          }
          deps.queue.enqueueMessageCheck(queueJid);
          continue;
        }

        const needsTrigger = !isMainGroup && group.requiresTrigger !== false;
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
          if (!hasTrigger) continue;
        }

        let initialBatch = getMessagesSince(
          chatJid,
          deps.getOrRecoverCursor(queueJid),
          MAX_MESSAGES_PER_PROMPT,
          { threadId: threadId ?? null },
        );
        if (initialBatch.length === 0) {
          initialBatch = groupMessages;
        }

        let pipedAny = false;
        let shouldEnqueueMessageCheck = false;
        let progressThreadId: string | undefined;
        let nextBatch: NewMessage[] | null = initialBatch;

        while (nextBatch && nextBatch.length > 0) {
          const messagesToSend = nextBatch;
          const latestMessage = messagesToSend[messagesToSend.length - 1];
          progressThreadId =
            normalizeThreadQueueId(latestMessage?.thread_id) ||
            progressThreadId;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (!deps.queue.sendMessage(queueJid, formatted, { threadId })) {
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
          deps.saveState();

          if (messagesToSend.length < MAX_MESSAGES_PER_PROMPT) {
            break;
          }

          nextBatch = getMessagesSince(
            chatJid,
            deps.getOrRecoverCursor(queueJid),
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
          const progressPromise = progressThreadId
            ? deps.sendProgressUpdate(
                chatJid,
                'Still working on it, got your follow-up.',
                { threadId: progressThreadId },
              )
            : deps.sendProgressUpdate(
                chatJid,
                'Still working on it, got your follow-up.',
              );
          progressPromise.catch((err: unknown) =>
            logger.warn(
              { chatJid, err },
              'Failed to send follow-up progress update',
            ),
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

export async function startMessagePollingLoop(
  deps: MessageLoopDeps,
): Promise<never> {
  while (true) {
    await runMessagePollingTick(deps);
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

export function recoverPendingMessages(deps: MessageLoopDeps): void {
  for (const [chatJid, group] of Object.entries(deps.getRegisteredGroups())) {
    const queuedThreads = new Set<string>();
    let pendingCount = 0;

    for (const threadId of getMessageThreadIds(chatJid)) {
      const queueJid = makeThreadQueueKey(chatJid, threadId);
      const pending = getMessagesSince(
        chatJid,
        deps.getOrRecoverCursor(queueJid),
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
