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
import { getMessagesSince, getNewMessages } from '../storage/db.js';
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

export interface MessageLoopDeps {
  assistantName: string;
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
    sendMessage: (chatJid: string, text: string) => boolean;
    enqueueMessageCheck: (chatJid: string) => void;
    closeStdin: (chatJid: string) => void;
    stopGroup?: (chatJid: string) => boolean;
  };
  handleActiveControlCommand?: (args: {
    chatJid: string;
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
      deps.assistantName,
    );

    if (messages.length > 0) {
      logger.info({ count: messages.length }, 'New messages');

      deps.setLastTimestamp(newTimestamp);
      deps.saveState();

      const messagesByGroup = new Map<string, NewMessage[]>();
      for (const msg of messages) {
        const existing = messagesByGroup.get(msg.chat_jid);
        if (existing) {
          existing.push(msg);
        } else {
          messagesByGroup.set(msg.chat_jid, [msg]);
        }
      }

      for (const [chatJid, groupMessages] of messagesByGroup) {
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
                group,
                message: loopCmdMsg,
                command: loopCommand,
              });
              if (handled) {
                continue;
              }
            }
            if (loopCommand?.kind === 'stop') {
              deps.queue.stopGroup?.(chatJid);
            } else {
              deps.queue.closeStdin(chatJid);
            }
          }
          deps.queue.enqueueMessageCheck(chatJid);
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
          deps.getOrRecoverCursor(chatJid),
          deps.assistantName,
          MAX_MESSAGES_PER_PROMPT,
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
            typeof latestMessage?.thread_id === 'string' &&
            latestMessage.thread_id.trim()
              ? latestMessage.thread_id.trim()
              : progressThreadId;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (!deps.queue.sendMessage(chatJid, formatted)) {
            shouldEnqueueMessageCheck = true;
            break;
          }

          pipedAny = true;
          logger.debug(
            { chatJid, count: messagesToSend.length },
            'Piped messages to active agent run',
          );
          deps.setAgentCursor(
            chatJid,
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
            deps.getOrRecoverCursor(chatJid),
            deps.assistantName,
            MAX_MESSAGES_PER_PROMPT,
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
          deps.queue.enqueueMessageCheck(chatJid);
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
    const pending = getMessagesSince(
      chatJid,
      deps.getOrRecoverCursor(chatJid),
      deps.assistantName,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      deps.queue.enqueueMessageCheck(chatJid);
    }
  }
}
