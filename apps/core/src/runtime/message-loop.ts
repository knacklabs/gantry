import {
  getTriggerPattern,
  MAX_MESSAGES_PER_PROMPT,
  POLL_INTERVAL,
  TIMEZONE,
} from '../config/index.js';
import {
  decodeGroupMessageCursor,
  encodeGroupMessageCursor,
  toGroupMessageCursor,
} from '../shared/message-cursor.js';
import { logger } from '../infrastructure/logging/logger.js';
import {
  NewMessage,
  ProgressUpdateOptions,
  ConversationRoute,
  MessageSendOptions,
} from '../domain/types.js';
import type { RuntimeMessageRepository } from '../domain/repositories/ops-repo.js';
import { formatMessages } from '../messaging/router.js';
import { screenBatchPreAgent } from './group-guardrail.js';
import type { GuardrailClassifier } from '../application/guardrails/types.js';
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
import { isTestOperatorJid } from '../shared/test-mode.js';
import { IDLE_SWEEP_INTERVAL_MS } from './idle-session-sweep.js';

export interface MessageLoopDeps {
  getConversationRoutes: () => Record<string, ConversationRoute>;
  /**
   * Optional background pass that extracts durable memory from idle sessions of
   * opt-in agents. Run throttled and non-blocking from the poll loop; absent for
   * callers/tests that don't exercise idle extraction.
   */
  runIdleSweep?: () => Promise<void>;
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
  /**
   * Delivers a message to the customer-facing channel. Used by the
   * continuation-path guardrail to send a policy's canned reply without
   * spawning/continuing an agent. Optional so existing callers/tests that
   * never exercise the continuation guardrail keep working.
   */
  sendChannelMessage?: (
    chatJid: string,
    text: string,
    options?: MessageSendOptions,
  ) => Promise<void>;
  /**
   * Pre-agent guardrail classifier. When present, inbound messages routed to an
   * already-running agent (the continuation path) are screened the same way the
   * spawn path screens them in processGroupMessages, so the guardrail applies to
   * every message regardless of path.
   */
  guardrailClassifier?: GuardrailClassifier;
  queue: {
    sendMessage: (
      chatJid: string,
      text: string,
      options?: {
        threadId?: string | null;
        senderUserIds?: readonly string[] | null;
      },
    ) => boolean;
    enqueueMessageCheck: (chatJid: string) => void;
    closeStdin: (chatJid: string) => void;
    stopGroup?: (chatJid: string) => boolean;
    /**
     * True when an agent run is live for this queue (the continuation path).
     * Gates the tick's guardrail screen: only this path pipes straight to
     * the live agent, so only it screens in the tick — the no-agent case
     * defers to the spawn path (processGroupMessages). Required (not
     * optional like stopGroup?) because it gates a SAFETY screen: a
     * silently-absent gate could turn "skipped here" into "piped
     * unscreened".
     */
    isGroupActive: (chatJid: string) => boolean;
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

function messageIsAfterGroupCursor(
  cursor: string,
  message: Pick<NewMessage, 'id' | 'timestamp'>,
): boolean {
  const decoded = decodeGroupMessageCursor(cursor);
  if (!decoded.timestamp) return true;
  if (message.timestamp > decoded.timestamp) return true;
  if (message.timestamp < decoded.timestamp) return false;
  return message.id > decoded.id;
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
        const agentCommandNames = group.agentConfig?.plugins?.commands ?? [];
        const loopCmdMsg = groupMessages.find(
          (m) =>
            extractSessionCommand(
              m.content,
              triggerPattern,
              agentCommandNames,
            ) !== null,
        );

        if (loopCmdMsg) {
          const loopCommand = extractSessionCommand(
            loopCmdMsg.content,
            triggerPattern,
            agentCommandNames,
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
              ) ||
                // DEV/TESTING ONLY: the configured test operator may run session
                // commands (e.g. /new) on their own conversation even while the
                // agent run is warm, so the scenario harness can fully reset
                // between runs. No-op in production (operator phone unset).
                isTestOperatorJid(chatJid),
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
          if (!hasTrigger) continue;
        }

        const currentCursor = await deps.getOrRecoverCursor(queueJid);
        let initialBatch = await opsRepository.getMessagesSince(
          chatJid,
          currentCursor,
          MAX_MESSAGES_PER_PROMPT,
          { threadId: threadId ?? null },
        );
        if (initialBatch.length === 0) {
          initialBatch = groupMessages.filter((message) =>
            messageIsAfterGroupCursor(currentCursor, message),
          );
        }
        if (initialBatch.length === 0) continue;

        let pipedAny = false;
        let handledWithoutAgent = false;
        let shouldEnqueueMessageCheck = false;
        let nextBatch: NewMessage[] | null = initialBatch;

        while (nextBatch && nextBatch.length > 0) {
          const messagesToSend = nextBatch;

          // Guardrail parity (continuation path): this path pipes straight
          // to the live agent, bypassing processGroupMessages, so it must
          // screen here, via the same screenBatchPreAgent the spawn path
          // uses — both doors then decide identically. Without this screen,
          // a policy-violating message arriving while the agent is warm
          // would bypass the guardrail entirely.
          //
          // Gated on isGroupActive (and sendChannelMessage being wired) so
          // we screen ONLY when piping to a live agent; the no-agent case
          // defers to the spawn path instead of double-screening.
          // SAFETY: when the gate is false this block is skipped with NO
          // await before the synchronous sendMessage below, and GroupQueue
          // guarantees `!isGroupActive(jid) ⇒ sendMessage(jid) === false`,
          // so a skipped batch can never pipe to a live agent unscreened.
          // Never add an await before the pipe. (Thread-scoped runs alias
          // the parent JID, so a bare-parent message mid-run may screen
          // here AND defer to spawn: twice, never unscreened.)
          if (deps.sendChannelMessage && deps.queue.isGroupActive(queueJid)) {
            const sendChannelMessage = deps.sendChannelMessage;
            const guardrailResult = await screenBatchPreAgent({
              repository: opsRepository,
              group,
              chatJid,
              queueJid,
              threadId: threadId ?? null,
              messages: messagesToSend,
              guardrailClassifier: deps.guardrailClassifier,
              allowInlineSystemPromptAppend: false,
              sendMessage: (text: string, options?: MessageSendOptions) =>
                sendChannelMessage(chatJid, text, options),
              buildMessageOptions: (tid?: string) =>
                tid ? { threadId: tid } : undefined,
              setCursor: deps.setAgentCursor,
              saveState: deps.saveState,
              info: (metadata, message) => logger.info(metadata, message),
            });
            if (guardrailResult.handled) {
              // Canned reply sent and cursor advanced past this batch inside the
              // guardrail. Do not pipe it to the agent. Only re-enqueue when
              // this batch hit the read limit; shorter batches prove there is
              // no known tail to drain, and re-enqueueing can replay stale
              // direct guardrail replies into a later customer turn.
              handledWithoutAgent = true;
              shouldEnqueueMessageCheck =
                messagesToSend.length >= MAX_MESSAGES_PER_PROMPT;
              break;
            }
          }

          const formatted = formatMessages(messagesToSend, TIMEZONE);
          const senderUserIds = resolveNonSelfSenderIds(messagesToSend);
          const sent = deps.queue.sendMessage(queueJid, formatted, {
            threadId,
            senderUserIds,
          });
          if (!sent) {
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

        if ((!pipedAny && !handledWithoutAgent) || shouldEnqueueMessageCheck) {
          deps.queue.enqueueMessageCheck(queueJid);
        }
      }
    }
  } catch (err) {
    logger.error({ err }, 'Error in message loop');
  }
}

/**
 * Builds the throttled, non-blocking trigger for the idle-session memory sweep.
 * Call the returned function once per poll tick: it starts a sweep at most once
 * per {@link IDLE_SWEEP_INTERVAL_MS}, and never while one is still in flight, so
 * a sweep that outlasts the interval just delays the next start rather than
 * overlapping with itself. Spacing is measured start-to-start. When no sweep is
 * wired (tests, or callers that haven't opted into idle extraction) the trigger
 * is a no-op.
 */
function createThrottledIdleSweep(
  runIdleSweep: MessageLoopDeps['runIdleSweep'],
): () => void {
  if (!runIdleSweep) return () => {};
  const sweep = runIdleSweep; // capture the narrowed (non-undefined) value
  let lastSweepAt = 0;
  let sweepInFlight = false;
  return function triggerIdleSweepIfDue(): void {
    if (sweepInFlight) return;
    const now = Date.now();
    if (now - lastSweepAt < IDLE_SWEEP_INTERVAL_MS) return;
    lastSweepAt = now;
    sweepInFlight = true;
    // Background: never block customer message processing on extraction.
    void sweep()
      .catch((err) => logger.warn({ err }, 'Idle session sweep failed'))
      .finally(() => {
        sweepInFlight = false;
      });
  };
}

export async function startMessagePollingLoop(
  deps: MessageLoopDeps,
): Promise<never> {
  const triggerIdleSweepIfDue = createThrottledIdleSweep(deps.runIdleSweep);
  while (true) {
    await runMessagePollingTick(deps);
    triggerIdleSweepIfDue();
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
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
