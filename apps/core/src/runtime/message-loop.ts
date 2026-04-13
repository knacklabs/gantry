import {
  getTriggerPattern,
  MAX_MESSAGES_PER_PROMPT,
  POLL_INTERVAL,
  TIMEZONE,
} from '../core/config.js';
import { logger } from '../core/logger.js';
import { Channel, NewMessage, RegisteredGroup } from '../core/types.js';
import { getMessagesSince, getNewMessages } from '../storage/db.js';
import { formatMessages } from '../messaging/router.js';
import {
  isTriggerAllowed,
  loadSenderAllowlist,
} from '../platform/sender-allowlist.js';
import {
  extractSessionCommand,
  isSessionCommandAllowed,
} from '../session/session-commands.js';

export interface MessageLoopDeps {
  assistantName: string;
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  getLastTimestamp: () => string;
  setLastTimestamp: (timestamp: string) => void;
  getOrRecoverCursor: (chatJid: string) => string;
  setAgentCursor: (chatJid: string, timestamp: string) => void;
  saveState: () => void;
  findChannel: (chatJid: string) => Channel | undefined;
  queue: {
    sendMessage: (chatJid: string, text: string) => boolean;
    enqueueMessageCheck: (chatJid: string) => void;
    closeStdin: (chatJid: string) => void;
    stopGroup?: (chatJid: string) => boolean;
  };
}

export async function startMessagePollingLoop(
  deps: MessageLoopDeps,
): Promise<never> {
  while (true) {
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

          const channel = deps.findChannel(chatJid);
          if (!channel) {
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
            if (
              isSessionCommandAllowed(
                isMainGroup,
                loopCmdMsg.is_from_me === true,
              )
            ) {
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
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          const allPending = getMessagesSince(
            chatJid,
            deps.getOrRecoverCursor(chatJid),
            deps.assistantName,
            MAX_MESSAGES_PER_PROMPT,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          if (deps.queue.sendMessage(chatJid, formatted)) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            deps.setAgentCursor(
              chatJid,
              messagesToSend[messagesToSend.length - 1].timestamp,
            );
            deps.saveState();
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err: unknown) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
            channel
              .sendProgressUpdate?.(
                chatJid,
                'Still working on it, got your follow-up.',
              )
              ?.catch((err: unknown) =>
                logger.warn(
                  { chatJid, err },
                  'Failed to send follow-up progress update',
                ),
              );
          } else {
            deps.queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
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
