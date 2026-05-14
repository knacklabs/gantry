import { App } from '@slack/bolt';

import { logger } from '../../infrastructure/logging/logger.js';
import {
  MessageDeliveryResult,
  MessageSendOptions,
  ProgressUpdateOptions,
} from '../../domain/types.js';
import { PartialMessageDeliveryError } from '../../domain/messages/partial-delivery.js';
import {
  channelProgressStateFilePath,
  readProgressStateEntries,
  writeProgressStateEntries,
} from '../progress-state-file.js';
import {
  ActiveProgressState,
  ActiveStreamState,
  PendingPermissionPrompt,
  PendingUserQuestionState,
} from './channel-state.js';
import {
  SLACK_FALLBACK_CHUNK_MAX_LENGTH,
  splitSlackTextByCodeUnits,
} from './text-limits.js';
import { nowIso } from '../../shared/time/datetime.js';
import { slackMessageActionBlocks } from './message-action-affordances.js';

type SlackPostMessagePayload = {
  channel: string;
  text: string;
  thread_ts?: string;
  blocks?: Array<Record<string, unknown>>;
};
type SlackDeliveryLogger = {
  warn(metadata: Record<string, unknown>, message: string): void;
};
export type SlackSnippetFallbackInput = {
  channelId: string;
  text: string;
  threadId?: string;
  reason: string;
};
export type SlackSnippetFallbackResult = {
  fallbackArtifactId: string;
  externalMessageId?: string;
};
const SLACK_RETRY_DELAY_FALLBACK_MS = 1000;
const SLACK_RETRY_DELAY_MAX_MS = 5000;

function clampSlackRetryDelayMs(delayMs: number): number {
  if (!Number.isFinite(delayMs) || delayMs <= 0) {
    return SLACK_RETRY_DELAY_FALLBACK_MS;
  }
  return Math.min(SLACK_RETRY_DELAY_MAX_MS, Math.max(1, Math.round(delayMs)));
}

function postMessageRetryDelayMs(input: unknown): number | null {
  const candidate = input as {
    retry_after?: unknown;
    retryAfter?: unknown;
    data?: { retry_after?: unknown; retryAfter?: unknown };
    headers?: { retry_after?: unknown; retryAfter?: unknown };
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    error?: unknown;
  };
  const values = [
    candidate.retry_after,
    candidate.retryAfter,
    candidate.data?.retry_after,
    candidate.data?.retryAfter,
    candidate.headers?.retry_after,
    candidate.headers?.retryAfter,
  ];
  for (const value of values) {
    if (typeof value === 'number' && value > 0) {
      return clampSlackRetryDelayMs(value * 1000);
    }
    if (typeof value === 'string') {
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        return clampSlackRetryDelayMs(parsed * 1000);
      }
    }
  }
  if (
    candidate.status === 429 ||
    candidate.statusCode === 429 ||
    candidate.code === 429 ||
    candidate.error === 'ratelimited'
  ) {
    return SLACK_RETRY_DELAY_FALLBACK_MS;
  }
  return null;
}

async function waitForPostMessageRetry(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) =>
    setTimeout(resolve, clampSlackRetryDelayMs(delayMs)),
  );
}

export function isSlackPayloadTooLarge(err: unknown): boolean {
  const candidate = err as {
    status?: unknown;
    statusCode?: unknown;
    code?: unknown;
    error?: unknown;
    data?: { error?: unknown };
    message?: unknown;
  };
  if (
    candidate.status === 413 ||
    candidate.statusCode === 413 ||
    candidate.code === 413
  ) {
    return true;
  }
  const text = [
    candidate.error,
    candidate.data?.error,
    candidate.message,
  ].filter((value): value is string => typeof value === 'string');
  return text.some((value) => /msg_too_long|too_long|payload/i.test(value));
}

export async function postSlackMessageWithRetry(
  app: App | null,
  payload: SlackPostMessagePayload,
  context: { jid: string; part: number; totalParts: number },
  warnings: string[],
  log: SlackDeliveryLogger,
): Promise<{ ts?: string }> {
  if (!app) throw new Error('Slack app not initialized');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const posted = (await app.client.chat.postMessage(payload)) as {
        ok?: boolean;
        ts?: string;
        error?: string;
        retry_after?: number;
      };
      if (posted.ok === false) {
        const retryDelayMs = postMessageRetryDelayMs(posted);
        if (retryDelayMs !== null && attempt < 2) {
          warnings.push('slack.rate_limited_retry');
          log.warn(
            { ...context, attempt: attempt + 1, retryDelayMs },
            'Slack postMessage rate-limited; retrying',
          );
          await waitForPostMessageRetry(retryDelayMs);
          continue;
        }
        throw new Error(posted.error || 'Slack postMessage failed');
      }
      return posted;
    } catch (err) {
      const retryDelayMs = postMessageRetryDelayMs(err);
      if (retryDelayMs !== null && attempt < 2) {
        warnings.push('slack.rate_limited_retry');
        log.warn(
          { ...context, attempt: attempt + 1, retryDelayMs },
          'Slack postMessage rate-limited via error; retrying',
        );
        await waitForPostMessageRetry(retryDelayMs);
        continue;
      }
      throw err;
    }
  }
  throw new Error('Slack postMessage retries exhausted');
}

export async function sendSlackMessage(input: {
  app: App | null;
  jid: string;
  channelId: string;
  formattedText: string;
  options: MessageSendOptions;
  log: SlackDeliveryLogger;
  sendSnippetFallback: (
    fallback: SlackSnippetFallbackInput,
  ) => Promise<SlackSnippetFallbackResult | null>;
}): Promise<MessageDeliveryResult | void> {
  if (!input.app) return;

  const formatted = input.formattedText;
  if (!formatted) return;

  const parts = splitSlackTextByCodeUnits(
    formatted,
    SLACK_FALLBACK_CHUNK_MAX_LENGTH,
  );
  const warnings: string[] = [];
  if (parts.length > 1) warnings.push(`slack.message.chunked:${parts.length}`);

  const externalMessageIds: string[] = [];
  let deliveredParts = 0;
  for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
    const part = parts[partIndex];
    const actionBlocks =
      partIndex === parts.length - 1
        ? slackMessageActionBlocks(part, input.options.actionAffordances)
        : undefined;
    try {
      const posted = await postSlackMessageWithRetry(
        input.app,
        {
          channel: input.channelId,
          text: part,
          ...(input.options.threadId
            ? { thread_ts: input.options.threadId }
            : {}),
          ...(actionBlocks ? { blocks: actionBlocks } : {}),
        },
        { jid: input.jid, part: partIndex + 1, totalParts: parts.length },
        warnings,
        input.log,
      );
      if (posted.ts) externalMessageIds.push(posted.ts);
      deliveredParts += 1;
    } catch (err) {
      if (deliveredParts === 0 && isSlackPayloadTooLarge(err)) {
        const fallback = await input.sendSnippetFallback({
          channelId: input.channelId,
          text: formatted,
          threadId: input.options.threadId,
          reason: 'payload_too_large',
        });
        if (fallback) {
          warnings.push('slack.snippet_fallback');
          const ids = fallback.externalMessageId
            ? [fallback.externalMessageId]
            : [];
          return {
            ...(ids[0] ? { externalMessageId: ids[0] } : {}),
            ...(ids.length > 0 ? { externalMessageIds: ids } : {}),
            deliveredParts: ids.length,
            totalParts: parts.length,
            warnings,
            fallbackArtifactId: fallback.fallbackArtifactId,
          };
        }
      }
      if (deliveredParts > 0) {
        const unsentTail = parts.slice(deliveredParts).join('');
        const partial = new PartialMessageDeliveryError({
          cause: err,
          deliveredChunks: deliveredParts,
          name: 'PartialSlackDeliveryError',
          message: `Slack message partially delivered (${deliveredParts}/${parts.length} parts)`,
          totalChunks: parts.length,
        });
        Object.assign(partial, {
          deliveredParts,
          totalParts: parts.length,
          externalMessageIds,
          ...(unsentTail.trim()
            ? {
                retryTail: {
                  canonicalText: unsentTail,
                  providerPayload: {
                    provider: 'slack',
                    channelId: input.channelId,
                    ...(input.options.threadId
                      ? { threadId: input.options.threadId }
                      : {}),
                  },
                },
              }
            : {}),
          ...(warnings.length > 0 ? { warnings } : {}),
        });
        throw partial;
      }
      throw err;
    }
  }

  return {
    ...(externalMessageIds[0]
      ? { externalMessageId: externalMessageIds[0] }
      : {}),
    ...(externalMessageIds.length > 0 ? { externalMessageIds } : {}),
    deliveredParts,
    totalParts: parts.length,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export async function sendSlackFallbackStreamParts(input: {
  app: App | null;
  jid: string;
  state: ActiveStreamState;
  fallbackParts: string[];
  log: SlackDeliveryLogger;
}): Promise<void> {
  if (!input.app) throw new Error('Slack app not initialized');
  let deliveredParts = 0;
  const visibleFallbackMessageIds = () =>
    input.state.fallbackMessageTs.filter(Boolean);
  const retryTailFromFallbackParts = () => {
    const tail = input.fallbackParts.slice(deliveredParts).join('');
    if (deliveredParts > 0 || !tail) return tail;
    const previousFallbackText =
      input.state.lastNativeText &&
      input.state.lastSentText.startsWith(input.state.lastNativeText)
        ? input.state.lastSentText.slice(input.state.lastNativeText.length)
        : input.state.lastSentText;
    if (previousFallbackText && tail.startsWith(previousFallbackText)) {
      return tail.slice(previousFallbackText.length);
    }
    return tail;
  };
  for (
    let partIndex = 0;
    partIndex < input.fallbackParts.length;
    partIndex += 1
  ) {
    const part = input.fallbackParts[partIndex];
    if (!part) continue;
    try {
      const existingTs = input.state.fallbackMessageTs[partIndex];
      if (existingTs) {
        await input.app.client.chat.update({
          channel: input.state.channelId,
          ts: existingTs,
          text: part,
        });
        deliveredParts += 1;
        continue;
      }
      const posted = await postSlackMessageWithRetry(
        input.app,
        {
          channel: input.state.channelId,
          text: part,
          ...(input.state.threadId ? { thread_ts: input.state.threadId } : {}),
        },
        {
          jid: input.jid,
          part: partIndex + 1,
          totalParts: input.fallbackParts.length,
        },
        [],
        input.log,
      );
      if (posted.ts) input.state.fallbackMessageTs[partIndex] = posted.ts;
      deliveredParts += 1;
    } catch (err) {
      const externalMessageIds = visibleFallbackMessageIds();
      const visibleDeliveredChunks = Math.max(
        deliveredParts,
        externalMessageIds.length > 0 ? 1 : 0,
      );
      if (visibleDeliveredChunks > 0) {
        const unsentTail = retryTailFromFallbackParts();
        const totalChunks = Math.max(
          input.fallbackParts.length,
          visibleDeliveredChunks + (unsentTail.trim() ? 1 : 0),
        );
        const partial = new PartialMessageDeliveryError({
          cause: err,
          deliveredChunks: visibleDeliveredChunks,
          name: 'PartialSlackStreamingFallbackDeliveryError',
          message: `Slack fallback stream partially delivered (${visibleDeliveredChunks}/${totalChunks} parts)`,
          totalChunks,
        });
        Object.assign(partial, {
          deliveredParts,
          totalParts: totalChunks,
          ...(externalMessageIds[0]
            ? { externalMessageId: externalMessageIds[0] }
            : {}),
          ...(externalMessageIds.length > 0 ? { externalMessageIds } : {}),
          warnings: [
            'slack.streaming_fallback_partial_delivery',
            ...(deliveredParts === 0
              ? ['slack.streaming_fallback_update_unconfirmed']
              : []),
          ],
          ...(unsentTail.trim()
            ? {
                retryTail: {
                  canonicalText: unsentTail,
                  providerPayload: {
                    provider: 'slack',
                    channelId: input.state.channelId,
                    ...(externalMessageIds[0]
                      ? { externalMessageId: externalMessageIds[0] }
                      : {}),
                    ...(externalMessageIds.length > 0
                      ? { externalMessageIds }
                      : {}),
                    deliveredParts,
                    totalParts: totalChunks,
                    ...(input.state.threadId
                      ? { threadId: input.state.threadId }
                      : {}),
                  },
                },
              }
            : {}),
        });
        throw partial;
      }
      throw err;
    }
  }
  input.state.messageTs = input.state.fallbackMessageTs[0];
}

export async function sendSlackProgressUpdate(input: {
  app: App | null;
  channelId: string;
  key: string;
  text: string;
  options: ProgressUpdateOptions;
  activeProgress: Map<string, ActiveProgressState>;
  persistProgress: () => void;
}): Promise<void> {
  if (!input.app) {
    logger.info(
      {
        channelId: input.channelId,
        key: input.key,
        progressText: input.text,
        options: input.options,
      },
      'Progress lifecycle slack skipped without app',
    );
    return;
  }
  const trimmed = input.text.trim();
  if (!trimmed) {
    if (input.options.done) {
      input.activeProgress.delete(input.key);
      input.persistProgress();
      logger.info(
        {
          channelId: input.channelId,
          key: input.key,
          generation: input.options.generation,
        },
        'Progress lifecycle slack cleared empty done',
      );
    }
    return;
  }

  let existing = input.activeProgress.get(input.key);
  logger.info(
    {
      channelId: input.channelId,
      key: input.key,
      progressText: trimmed,
      done: input.options.done ?? false,
      replaceOnly: input.options.replaceOnly ?? false,
      generation: input.options.generation,
      existing: Boolean(existing),
      existingGeneration: existing?.generation,
      existingMessageTs: existing?.messageTs,
    },
    'Progress lifecycle slack receive',
  );
  if (
    existing &&
    input.options.generation !== undefined &&
    existing.generation !== undefined &&
    existing.generation !== input.options.generation &&
    !(input.options.done && input.options.generation > existing.generation)
  ) {
    if (input.options.done || input.options.replaceOnly) {
      logger.info(
        {
          channelId: input.channelId,
          key: input.key,
          done: input.options.done ?? false,
          replaceOnly: input.options.replaceOnly ?? false,
          generation: input.options.generation,
          existingGeneration: existing.generation,
        },
        'Progress lifecycle slack dropped generation mismatch',
      );
      return;
    }
    logger.info(
      {
        channelId: input.channelId,
        key: input.key,
        done: input.options.done ?? false,
        generation: input.options.generation,
        existingGeneration: existing.generation,
      },
      'Progress lifecycle slack generation rollover',
    );
    input.activeProgress.delete(input.key);
    input.persistProgress();
    if (!input.options.done) existing = undefined;
  }
  if (!existing && input.options.replaceOnly) {
    logger.info(
      {
        channelId: input.channelId,
        key: input.key,
        progressText: trimmed,
        generation: input.options.generation,
      },
      'Progress lifecycle slack dropped replaceOnly without handle',
    );
    return;
  }

  if (input.options.threadId) {
    try {
      await input.app.client.apiCall('assistant.threads.setStatus', {
        channel_id: input.channelId,
        thread_ts: input.options.threadId,
        status: trimmed,
      });
    } catch {
      // Optional surface; fall through to message-based progress.
    }
  }

  if (!existing) {
    const sent = (await input.app.client.chat.postMessage({
      channel: input.channelId,
      text: trimmed,
      ...(input.options.threadId ? { thread_ts: input.options.threadId } : {}),
    })) as { ts?: string };
    if (!input.options.done) {
      input.activeProgress.set(input.key, {
        channelId: input.channelId,
        threadId: input.options.threadId,
        messageTs: sent.ts,
        lastText: trimmed,
        ...(input.options.generation !== undefined
          ? { generation: input.options.generation }
          : {}),
      });
      input.persistProgress();
    }
    logger.info(
      {
        channelId: input.channelId,
        key: input.key,
        progressText: trimmed,
        done: input.options.done ?? false,
        generation: input.options.generation,
        messageTs: sent.ts,
        storedHandle: !input.options.done,
      },
      'Progress lifecycle slack sent new message',
    );
    return;
  }

  if (existing.lastText === trimmed) {
    if (input.options.done) {
      input.activeProgress.delete(input.key);
      input.persistProgress();
      logger.info(
        {
          channelId: input.channelId,
          key: input.key,
          generation: input.options.generation,
        },
        'Progress lifecycle slack cleared unchanged done',
      );
    } else {
      logger.info(
        {
          channelId: input.channelId,
          key: input.key,
          generation: input.options.generation,
        },
        'Progress lifecycle slack skipped unchanged text',
      );
    }
    return;
  }

  if (existing.messageTs) {
    await input.app.client.chat.update({
      channel: existing.channelId,
      ts: existing.messageTs,
      text: trimmed,
    });
  } else {
    const sent = (await input.app.client.chat.postMessage({
      channel: existing.channelId,
      text: trimmed,
      ...(existing.threadId ? { thread_ts: existing.threadId } : {}),
    })) as { ts?: string };
    existing.messageTs = sent.ts;
  }

  existing.lastText = trimmed;
  if (input.options.generation !== undefined)
    existing.generation = input.options.generation;
  if (input.options.done) {
    input.activeProgress.delete(input.key);
  } else {
    input.activeProgress.set(input.key, existing);
  }
  input.persistProgress();
  logger.info(
    {
      channelId: input.channelId,
      key: input.key,
      progressText: trimmed,
      done: input.options.done ?? false,
      generation: input.options.generation,
      messageTs: existing.messageTs,
    },
    'Progress lifecycle slack edited existing message',
  );
}

export async function waitForSlackUserQuestionSelection(input: {
  pendingKey: string;
  pendingState: PendingUserQuestionState;
  pendingUserQuestions: Map<string, PendingUserQuestionState>;
  timeoutMs: number;
  finalizeTimedOut: (pending: PendingUserQuestionState) => Promise<void>;
}): Promise<{ selected: string | string[]; answeredBy?: string }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const timedOut = input.pendingUserQuestions.get(input.pendingKey);
      if (!timedOut) return;
      void input.finalizeTimedOut(timedOut);
    }, input.timeoutMs);

    input.pendingUserQuestions.set(input.pendingKey, {
      ...input.pendingState,
      timer,
      resolve,
    });
  });
}

export function loadPersistedSlackProgress(
  botToken: string,
  activeProgress: Map<string, ActiveProgressState>,
): void {
  const entries = readProgressStateEntries(
    channelProgressStateFilePath('slack', botToken),
    'Slack',
  ) as unknown as Array<[string, ActiveProgressState]>;
  for (const [key, state] of entries) {
    if (
      typeof state.channelId === 'string' &&
      typeof state.lastText === 'string'
    ) {
      activeProgress.set(key, state);
    }
  }
}

export function persistSlackProgress(
  botToken: string,
  activeProgress: Map<string, ActiveProgressState>,
): void {
  writeProgressStateEntries(
    channelProgressStateFilePath('slack', botToken),
    'Slack',
    activeProgress.entries(),
  );
}

export function resolveSlackDisconnectPrompts(input: {
  pendingPermissionPrompts: Map<string, PendingPermissionPrompt>;
  pendingUserQuestions: Map<string, PendingUserQuestionState>;
}): void {
  for (const [requestId, pending] of input.pendingPermissionPrompts.entries()) {
    clearTimeout(pending.timer);
    pending.resolve({
      approved: false,
      decidedBy: 'system',
      reason: 'Slack channel disconnected',
    });
    input.pendingPermissionPrompts.delete(requestId);
  }

  for (const [key, pending] of input.pendingUserQuestions.entries()) {
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve({
      selected: pending.question.multiSelect ? [] : '',
      answeredBy: 'system',
    });
    input.pendingUserQuestions.delete(key);
  }
}

export async function disconnectSlackDelivery(input: {
  app: App | null;
  activeStreams: Map<string, ActiveStreamState>;
  streamGenerationByJid: Map<string, number>;
  sealedStreamGenerationByJid: Map<string, number>;
  activeProgress: Map<string, ActiveProgressState>;
  pendingPermissionPrompts: Map<string, PendingPermissionPrompt>;
  pendingUserQuestions: Map<string, PendingUserQuestionState>;
  stopNativeStream: (channelId: string, streamTs: string) => Promise<boolean>;
}): Promise<App | null> {
  resolveSlackDisconnectPrompts({
    pendingPermissionPrompts: input.pendingPermissionPrompts,
    pendingUserQuestions: input.pendingUserQuestions,
  });

  for (const state of input.activeStreams.values()) {
    if (state.nativeStreamTs) {
      void input.stopNativeStream(state.channelId, state.nativeStreamTs);
    }
  }
  input.activeStreams.clear();
  input.streamGenerationByJid.clear();
  input.sealedStreamGenerationByJid.clear();
  input.activeProgress.clear();

  if (input.app) await input.app.stop();
  return null;
}

export async function syncSlackGroups(input: {
  app: App | null;
  force: boolean;
  channelNameCache: Map<string, string>;
  resolveChannelName: (channelId: string) => Promise<string>;
  onChatMetadata: (
    jid: string,
    observedAt: string,
    displayName: string,
    channel: string,
    isGroup: boolean,
  ) => Promise<void>;
}): Promise<void> {
  if (!input.app) return;
  const now = nowIso();
  let cursor: string | undefined;

  do {
    const page = (await input.app.client.conversations.list({
      types: 'public_channel,private_channel,im,mpim',
      exclude_archived: true,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    })) as {
      channels?: Array<{ id?: string; name?: string; is_im?: boolean }>;
      response_metadata?: { next_cursor?: string };
    };

    const channels = Array.isArray(page.channels) ? page.channels : [];
    for (const channel of channels) {
      const channelId = channel.id;
      if (!channelId) continue;
      if (!input.force && input.channelNameCache.has(channelId)) continue;
      const name = channel.name || (await input.resolveChannelName(channelId));
      input.channelNameCache.set(channelId, name);
      await input.onChatMetadata(
        `sl:${channelId}`,
        now,
        name,
        'slack',
        !channel.is_im,
      );
    }

    const nextCursor = page.response_metadata?.next_cursor?.trim() || '';
    cursor = nextCursor || undefined;
  } while (cursor);
}
