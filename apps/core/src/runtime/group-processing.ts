import { ChildProcess } from 'child_process';

import {
  ASSISTANT_NAME,
  getDefaultModelConfig,
  getTriggerPattern,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  TIMEZONE,
} from '../core/config.js';
import {
  encodeGroupMessageCursor,
  toGroupMessageCursor,
} from '../core/message-cursor.js';
import { logger } from '../core/logger.js';
import {
  MessageSendOptions,
  ProgressUpdateOptions,
  RegisteredGroup,
  StreamingChunkOptions,
  ThinkingOverride,
} from '../core/types.js';
import { writeMemoryContextSnapshot } from '../memory/memory-ipc.js';
import { MemoryService } from '../memory/memory-service.js';
import {
  formatMessages,
  formatOutboundForChannel,
} from '../messaging/router.js';
import {
  isSenderExplicitlyAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
} from '../platform/sender-allowlist.js';
import {
  deleteSession,
  getAllJobs,
  getMessagesSince,
  listRecentJobEvents,
  getRecentJobRuns,
} from '../storage/db.js';
import {
  AvailableGroup,
  AgentOutput,
  spawnAgent,
  writeJobEventsSnapshot,
  writeJobRunsSnapshot,
  writeJobsSnapshot,
  writeGroupsSnapshot,
} from './agent-spawn.js';
import { archiveSessionTranscript } from '../session/session-transcript-archive.js';
import { handleSessionCommand } from '../session/session-commands.js';

const TYPING_HEARTBEAT_INTERVAL_MS = 4_000;
const ELAPSED_PROGRESS_INTERVAL_MS = 60_000;
const NO_OUTPUT_WARNING_INTERVAL_MS = 180_000;
let streamingGenerationCounter = 0;

function nextStreamingGeneration(): number {
  streamingGenerationCounter += 1;
  return streamingGenerationCounter;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
}

export interface GroupProcessingDeps {
  channelRuntime: {
    hasChannel: (chatJid: string) => boolean;
    supportsStreaming: (chatJid: string) => boolean;
    supportsProgress: (chatJid: string) => boolean;
    sendMessage: (
      chatJid: string,
      rawText: string,
      options?: MessageSendOptions,
    ) => Promise<void>;
    sendStreamingChunk: (
      chatJid: string,
      rawText: string,
      options?: StreamingChunkOptions,
    ) => Promise<void>;
    resetStreaming: (chatJid: string) => void;
    setTyping: (chatJid: string, isTyping: boolean) => Promise<void>;
    sendProgressUpdate: (
      chatJid: string,
      text: string,
      options?: ProgressUpdateOptions,
    ) => Promise<void>;
  };
  getGroup: (chatJid: string) => RegisteredGroup | undefined;
  getSession: (groupFolder: string) => string | undefined;
  setSession: (groupFolder: string, sessionId: string) => void;
  clearSession: (groupFolder: string) => void;
  getCursor: (chatJid: string) => string;
  setCursor: (chatJid: string, timestamp: string) => void;
  saveState: () => void;
  setGroupModelOverride: (chatJid: string, model: string | undefined) => void;
  setGroupThinkingOverride: (
    chatJid: string,
    thinking: ThinkingOverride | undefined,
  ) => void;
  getAvailableGroups: () => AvailableGroup[];
  getRegisteredJids: () => Set<string>;
  queue: {
    closeStdin: (chatJid: string) => void;
    notifyIdle: (chatJid: string) => void;
    stopGroup?: (chatJid: string) => boolean;
    registerProcess: (
      groupJid: string,
      proc: ChildProcess,
      containerName: string,
      groupFolder?: string,
      stopAliasJids?: string | string[],
    ) => void;
  };
}

export function createGroupProcessor(deps: GroupProcessingDeps): {
  processGroupMessages: (chatJid: string) => Promise<boolean>;
} {
  async function runAgent(
    group: RegisteredGroup,
    prompt: string,
    chatJid: string,
    onOutput?: (output: AgentOutput) => Promise<void>,
    options?: { timeoutMs?: number },
    userId?: string,
    onMemoryContext?: (retrievedItemIds: string[]) => void,
  ): Promise<'success' | 'error'> {
    const isMain = group.isMain === true;
    const sessionId = deps.getSession(group.folder);

    const jobs = getAllJobs().map((job) => ({
      id: job.id,
      name: job.name,
      prompt: job.prompt,
      model: job.model || null,
      script: job.script || undefined,
      schedule_type: job.schedule_type,
      schedule_value: job.schedule_value,
      status: job.status,
      group_scope: job.group_scope,
      linked_sessions: job.linked_sessions,
      thread_id: job.thread_id,
      next_run: job.next_run,
      created_by: job.created_by,
      created_at: job.created_at,
      updated_at: job.updated_at,
      silent: job.silent,
      cleanup_after_ms: job.cleanup_after_ms,
      timeout_ms: job.timeout_ms,
      max_retries: job.max_retries,
      retry_backoff_ms: job.retry_backoff_ms,
      max_consecutive_failures: job.max_consecutive_failures,
      consecutive_failures: job.consecutive_failures,
      execution_mode: job.execution_mode,
      pause_reason: job.pause_reason,
    }));
    writeJobsSnapshot(group.folder, isMain, jobs);
    writeJobRunsSnapshot(group.folder, isMain, getRecentJobRuns(200), jobs);
    writeJobEventsSnapshot(
      group.folder,
      isMain,
      listRecentJobEvents(500),
      jobs,
    );

    try {
      const contextSnapshot = await writeMemoryContextSnapshot(
        group.folder,
        isMain,
        prompt,
        userId,
      );
      onMemoryContext?.(contextSnapshot.retrievedItemIds);
    } catch (err) {
      logger.warn(
        { err, group: group.name },
        'Memory context snapshot failed; continuing without memory context',
      );
      onMemoryContext?.([]);
    }

    writeGroupsSnapshot(
      group.folder,
      isMain,
      deps.getAvailableGroups(),
      deps.getRegisteredJids(),
    );

    let pendingSessionId: string | null = null;

    const wrappedOnOutput = onOutput
      ? async (output: AgentOutput) => {
          if (output.status !== 'error' && output.newSessionId) {
            pendingSessionId = output.newSessionId;
          }
          await onOutput(output);
        }
      : undefined;

    try {
      const output = await spawnAgent(
        group,
        {
          prompt,
          sessionId,
          groupFolder: group.folder,
          chatJid,
          isMain,
          assistantName: ASSISTANT_NAME,
          thinking: group.agentConfig?.thinking,
        },
        (proc, containerName) =>
          deps.queue.registerProcess(
            chatJid,
            proc,
            containerName,
            group.folder,
          ),
        wrappedOnOutput,
        options,
      );

      if (output.status === 'error') {
        const staleSessionId = sessionId || '';
        const isStaleSession =
          staleSessionId &&
          output.error &&
          /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(
            output.error,
          );

        if (isStaleSession) {
          logger.warn(
            {
              group: group.name,
              staleSessionId,
              error: output.error,
            },
            'Stale session detected — clearing for next retry',
          );
          archiveSessionTranscript({
            groupFolder: group.folder,
            sessionId: staleSessionId,
            assistantName: ASSISTANT_NAME,
            cause: 'stale-session',
            errorSummary: output.error,
            writePlaceholderOnMissing: true,
          });
          deps.clearSession(group.folder);
        }

        logger.error(
          { group: group.name, error: output.error },
          'Agent runner error',
        );
        return 'error';
      }

      const nextSessionId = output.newSessionId || pendingSessionId;
      if (nextSessionId) {
        deps.setSession(group.folder, nextSessionId);
      }

      return 'success';
    } catch (err) {
      logger.error({ group: group.name, err }, 'Agent error');
      return 'error';
    }
  }

  async function processGroupMessages(chatJid: string): Promise<boolean> {
    const group = deps.getGroup(chatJid);
    if (!group) return true;

    if (!deps.channelRuntime.hasChannel(chatJid)) {
      logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
      return true;
    }

    const isMainGroup = group.isMain === true;

    const missedMessages = getMessagesSince(
      chatJid,
      deps.getCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );

    if (missedMessages.length === 0) return true;

    const latestMessage = missedMessages[missedMessages.length - 1];
    let latestSeenCursor = encodeGroupMessageCursor(
      toGroupMessageCursor(latestMessage),
    );
    let activeThreadId =
      typeof latestMessage?.thread_id === 'string' &&
      latestMessage.thread_id.trim()
        ? latestMessage.thread_id.trim()
        : undefined;
    const refreshActiveThreadId = () => {
      try {
        const newerMessages = getMessagesSince(
          chatJid,
          latestSeenCursor,
          ASSISTANT_NAME,
          1,
        );
        if (newerMessages.length === 0) return;
        const newestMessage = newerMessages[newerMessages.length - 1];
        latestSeenCursor = encodeGroupMessageCursor(
          toGroupMessageCursor(newestMessage),
        );
        activeThreadId =
          typeof newestMessage.thread_id === 'string' &&
          newestMessage.thread_id.trim()
            ? newestMessage.thread_id.trim()
            : undefined;
      } catch (err) {
        logger.debug(
          { err, group: group.name },
          'Failed to refresh latest thread context during run',
        );
      }
    };
    const resolveThreadId = (threadId?: string): string | undefined => {
      if (threadId) return threadId;
      refreshActiveThreadId();
      return activeThreadId;
    };
    const streamGeneration = nextStreamingGeneration();
    const buildMessageOptions = (
      threadId?: string,
    ): { threadId: string } | undefined => {
      const resolved = resolveThreadId(threadId);
      return resolved ? { threadId: resolved } : undefined;
    };
    const buildStreamingOptions = (args: {
      threadId?: string;
      done?: boolean;
    }): { threadId?: string; done?: boolean; generation: number } => {
      const resolvedThread = resolveThreadId(args.threadId);
      const base = { generation: streamGeneration } as const;
      if (resolvedThread && args.done !== undefined) {
        return { ...base, threadId: resolvedThread, done: args.done };
      }
      if (resolvedThread) {
        return { ...base, threadId: resolvedThread };
      }
      if (args.done !== undefined) {
        return { ...base, done: args.done };
      }
      return { ...base };
    };
    const sendMessageToChannel = async (
      text: string,
      options?: MessageSendOptions,
    ): Promise<void> => {
      if (options) {
        await deps.channelRuntime.sendMessage(chatJid, text, options);
        return;
      }
      await deps.channelRuntime.sendMessage(chatJid, text);
    };
    const sendProgressToChannel = async (
      text: string,
      options?: ProgressUpdateOptions,
    ): Promise<void> => {
      if (options) {
        await deps.channelRuntime.sendProgressUpdate(chatJid, text, options);
        return;
      }
      await deps.channelRuntime.sendProgressUpdate(chatJid, text);
    };

    const cmdResult = await handleSessionCommand({
      missedMessages,
      isMainGroup,
      groupName: group.name,
      triggerPattern: getTriggerPattern(group.trigger),
      timezone: TIMEZONE,
      deps: {
        sendMessage: (text, options) =>
          sendMessageToChannel(text, buildMessageOptions(options?.threadId)),
        setTyping: (typing) => deps.channelRuntime.setTyping(chatJid, typing),
        runAgent: (prompt, onOutput, options) =>
          runAgent(group, prompt, chatJid, onOutput, options),
        closeStdin: () => deps.queue.closeStdin(chatJid),
        advanceCursor: (message) => {
          deps.setCursor(
            chatJid,
            encodeGroupMessageCursor(toGroupMessageCursor(message)),
          );
          deps.saveState();
        },
        formatMessages,
        getDefaultModel: () => getDefaultModelConfig().model,
        getGroupModelOverride: () => group.agentConfig?.model,
        setGroupModelOverride: (value) =>
          deps.setGroupModelOverride(chatJid, value),
        getGroupThinkingOverride: () => group.agentConfig?.thinking,
        setGroupThinkingOverride: (value) =>
          deps.setGroupThinkingOverride(chatJid, value),
        archiveCurrentSession: async (cause = 'new-session') => {
          const sessionId = deps.getSession(group.folder);
          if (!sessionId) return;
          archiveSessionTranscript({
            groupFolder: group.folder,
            sessionId,
            assistantName: ASSISTANT_NAME,
            cause,
          });
        },
        onSessionArchived: async (cause = 'new-session') => {
          await MemoryService.getInstance().reflectAfterTurn({
            groupFolder: group.folder,
            prompt: cause === 'manual-compact' ? '/compact' : '/new',
            result:
              cause === 'manual-compact'
                ? 'session compacted'
                : 'session archived',
            isMain: isMainGroup,
          });
        },
        clearCurrentSession: () => {
          deps.clearSession(group.folder);
          deleteSession(group.folder);
        },
        stopCurrentRun: () => deps.queue.stopGroup?.(chatJid) ?? false,
        isSenderControlAllowlisted: (msg) => {
          const allowlistCfg = loadSenderAllowlist();
          return isSenderExplicitlyAllowed(
            chatJid,
            msg.sender,
            allowlistCfg,
            group.folder,
          );
        },
        canSenderInteract: (msg) => {
          const hasTrigger = getTriggerPattern(group.trigger).test(
            msg.content.trim(),
          );
          const reqTrigger = !isMainGroup && group.requiresTrigger !== false;
          return (
            isMainGroup ||
            !reqTrigger ||
            (hasTrigger &&
              (msg.is_from_me ||
                isTriggerAllowed(
                  chatJid,
                  msg.sender,
                  loadSenderAllowlist(),
                  group.folder,
                )))
          );
        },
      },
    });
    if (cmdResult.handled) return cmdResult.success;

    if (!isMainGroup && group.requiresTrigger !== false) {
      const triggerPattern = getTriggerPattern(group.trigger);
      const allowlistCfg = loadSenderAllowlist();
      const hasTrigger = missedMessages.some(
        (m) =>
          triggerPattern.test(m.content.trim()) &&
          (m.is_from_me ||
            isTriggerAllowed(chatJid, m.sender, allowlistCfg, group.folder)),
      );
      if (!hasTrigger) {
        return true;
      }
    }

    const prompt = formatMessages(missedMessages, TIMEZONE);
    const previousCursor = deps.getCursor(chatJid) || '';
    deps.setCursor(
      chatJid,
      encodeGroupMessageCursor(
        toGroupMessageCursor(missedMessages[missedMessages.length - 1]),
      ),
    );
    deps.saveState();

    logger.info(
      { group: group.name, messageCount: missedMessages.length },
      'Processing messages',
    );
    try {
      deps.channelRuntime.resetStreaming(chatJid);
    } catch (err) {
      logger.debug(
        { err, group: group.name },
        'Failed to reset channel streaming state before processing',
      );
    }

    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        logger.debug(
          { group: group.name },
          'Idle timeout, closing agent runner stdin',
        );
        deps.queue.closeStdin(chatJid);
      }, IDLE_TIMEOUT);
    };

    await deps.channelRuntime.setTyping(chatJid, true);
    const startedAt = Date.now();
    let lastAgentProgressAt = startedAt;
    let lastNoOutputWarningAt = 0;
    let lastElapsedProgressAt = 0;
    let typingHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let progressTimer: ReturnType<typeof setInterval> | null = null;
    const supportsProgress = deps.channelRuntime.supportsProgress(chatJid);
    if (supportsProgress) {
      try {
        const progressOptions = buildMessageOptions();
        await sendProgressToChannel('Working on it...', progressOptions);
      } catch (err) {
        logger.debug(
          { err, group: group.name },
          'Failed to send initial progress update',
        );
      }
    }
    typingHeartbeatTimer = setInterval(() => {
      void deps.channelRuntime
        .setTyping(chatJid, true)
        .catch((err) =>
          logger.debug(
            { err, group: group.name },
            'Failed to refresh typing heartbeat',
          ),
        );
    }, TYPING_HEARTBEAT_INTERVAL_MS);
    progressTimer = setInterval(() => {
      if (!supportsProgress) return;
      const now = Date.now();
      const elapsedMs = now - startedAt;
      if (now - lastElapsedProgressAt >= ELAPSED_PROGRESS_INTERVAL_MS) {
        lastElapsedProgressAt = now;
        const progressOptions = buildMessageOptions();
        void sendProgressToChannel(
          `Still working (${formatElapsed(elapsedMs)})...`,
          progressOptions,
        ).catch((err) =>
          logger.debug(
            { err, group: group.name },
            'Failed to send elapsed progress update',
          ),
        );
      }
      if (
        now - lastAgentProgressAt >= NO_OUTPUT_WARNING_INTERVAL_MS &&
        now - lastNoOutputWarningAt >= NO_OUTPUT_WARNING_INTERVAL_MS
      ) {
        lastNoOutputWarningAt = now;
        const progressOptions = buildMessageOptions();
        void sendProgressToChannel(
          `No new output yet, still running (${formatElapsed(elapsedMs)})...`,
          progressOptions,
        ).catch((err) =>
          logger.debug(
            { err, group: group.name },
            'Failed to send no-output warning',
          ),
        );
      }
    }, 5_000);
    let hadError = false;
    let outputSentToUser = false;
    let collectedOutput = '';
    const supportsStreamingChunks =
      deps.channelRuntime.supportsStreaming(chatJid);
    let streamFinalized = false;
    const finalizeStreamingOutput = async (
      reason: 'success-marker' | 'error-marker' | 'turn-complete',
    ) => {
      if (!supportsStreamingChunks || streamFinalized) return;
      streamFinalized = true;
      try {
        await deps.channelRuntime.sendStreamingChunk(
          chatJid,
          '',
          buildStreamingOptions({ done: true }),
        );
      } catch (err) {
        logger.warn(
          { err, group: group.name, reason },
          'Failed to finalize streaming output',
        );
      }
    };
    let retrievedItemIdsForTurn: string[] = [];
    const memoryUserId = [...missedMessages]
      .reverse()
      .find((msg) => !msg.is_from_me && !msg.is_bot_message)?.sender;

    let output: 'success' | 'error' = 'error';
    try {
      output = await runAgent(
        group,
        prompt,
        chatJid,
        async (result) => {
          lastAgentProgressAt = Date.now();
          if (result.result) {
            const raw =
              typeof result.result === 'string'
                ? result.result
                : JSON.stringify(result.result);
            const text = formatOutboundForChannel(raw);
            logger.info(
              { group: group.name },
              `Agent output: ${raw.length} chars`,
            );
            if (text) {
              if (supportsStreamingChunks) {
                await deps.channelRuntime.sendStreamingChunk(
                  chatJid,
                  raw,
                  buildStreamingOptions({}),
                );
              } else {
                const messageOptions = buildMessageOptions();
                await sendMessageToChannel(text, messageOptions);
              }
              outputSentToUser = true;
              collectedOutput += `${text}\n`;
            }
            resetIdleTimer();
          }

          if (result.status === 'success' && !result.result) {
            await finalizeStreamingOutput('success-marker');
            deps.queue.notifyIdle(chatJid);
            // End the runner loop after a completed query so typing/progress
            // finalize promptly instead of waiting for idle timeout.
            deps.queue.closeStdin(chatJid);
          }

          if (result.status === 'error') {
            hadError = true;
            await finalizeStreamingOutput('error-marker');
          }
        },
        undefined,
        memoryUserId,
        (retrievedItemIds) => {
          retrievedItemIdsForTurn = retrievedItemIds;
        },
      );
    } finally {
      await finalizeStreamingOutput('turn-complete');
      if (typingHeartbeatTimer) clearInterval(typingHeartbeatTimer);
      if (progressTimer) clearInterval(progressTimer);
      const elapsed = formatElapsed(Date.now() - startedAt);
      if (supportsProgress) {
        const finalStatus =
          output === 'error' || hadError
            ? `Failed after ${elapsed}.`
            : `Done in ${elapsed}.`;
        try {
          const finalProgressOptions = buildStreamingOptions({ done: true });
          await sendProgressToChannel(finalStatus, finalProgressOptions);
        } catch (err) {
          logger.debug(
            { err, group: group.name },
            'Failed to send final progress update',
          );
        }
      }
      await deps.channelRuntime.setTyping(chatJid, false);
      if (idleTimer) clearTimeout(idleTimer);
    }

    if (output === 'error' || hadError) {
      if (outputSentToUser) {
        logger.warn(
          { group: group.name },
          'Agent error after output was sent, skipping cursor rollback to prevent duplicates',
        );
        return true;
      }
      deps.setCursor(chatJid, previousCursor);
      deps.saveState();
      logger.warn(
        { group: group.name },
        'Agent error, rolled back message cursor for retry',
      );
      return false;
    }

    try {
      await MemoryService.getInstance().reflectAfterTurn({
        groupFolder: group.folder,
        prompt,
        result: collectedOutput,
        isMain: isMainGroup,
        userId: memoryUserId,
        retrievedItemIds: retrievedItemIdsForTurn,
      });
    } catch (err) {
      logger.warn(
        { err, group: group.name },
        'Memory reflection failed after successful turn',
      );
    }

    return true;
  }

  return { processGroupMessages };
}
