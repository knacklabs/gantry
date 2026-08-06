import { App } from '@slack/bolt';
import { logger } from '../../infrastructure/logging/logger.js';
import {
  MessageDeliveryResult,
  MessageSendOptions,
  OnChatMetadata,
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
  PendingUserQuestionState,
} from './channel-state.js';
import {
  SLACK_FALLBACK_CHUNK_MAX_LENGTH,
  splitSlackTextByCodeUnits,
} from './text-limits.js';
import { nowIso } from '../../shared/time/datetime.js';
import {
  slackMessageActionBlocks,
  slackReviewMessageBlocks,
} from './message-action-affordances.js';
import { slackObserverDigestBlocks } from './observer-digest-affordances.js';
import { slackBrainReviewBlocks } from './brain-review-affordances.js';
import { slackThreadTsFromThreadId } from './thread-ts.js';
import {
  handleSlackThreadProgressStatus,
  isSlackTerminalSuccessText,
} from './thread-progress-status.js';
import {
  currentProcessSlackProgress,
  rejectOlderSlackProgressGeneration,
  slackProgressBootNonce,
} from './progress-restart.js';
import {
  clampSlackRetryDelayMs,
  slackRateLimitRetryDelayMs,
} from './channel-retry-delay.js';
// prettier-ignore
import { buildPartialSlackDelivery, deliverOversizedSlackPart, postActionsFollowUpNonFatal } from './oversized-part-delivery.js';
import {
  isSlackPayloadTooLarge,
  uploadSlackAttachments,
  type SlackSnippetFallbackInput,
  type SlackSnippetFallbackResult,
} from './file-delivery.js';
type SlackPostMessagePayload = {
  channel: string;
  text: string;
  thread_ts?: string;
  blocks?: Array<Record<string, unknown>>;
};
export type SlackDeliveryLogger = {
  warn(metadata: Record<string, unknown>, message: string): void;
};
export function slackActionBlocks(text: string, options: MessageSendOptions) {
  if (options.observerDigestView) {
    return slackObserverDigestBlocks(options.observerDigestView, {
      ...(options.providerAccountId
        ? { providerAccountId: options.providerAccountId }
        : {}),
    });
  }
  if (options.reviewMessageView) {
    return slackReviewMessageBlocks(options.reviewMessageView, {
      ...(options.providerAccountId
        ? { providerAccountId: options.providerAccountId }
        : {}),
    });
  }
  if (options.brainReviewView) {
    return slackBrainReviewBlocks(options.brainReviewView, {
      ...(options.providerAccountId
        ? { providerAccountId: options.providerAccountId }
        : {}),
    });
  }
  return options.actionAffordances
    ? slackMessageActionBlocks(text, options.actionAffordances, {
        providerAccountId: options.providerAccountId,
      })
    : undefined;
}
async function waitForPostMessageRetry(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) =>
    setTimeout(resolve, clampSlackRetryDelayMs(delayMs)),
  );
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
        const retryDelayMs = slackRateLimitRetryDelayMs(posted);
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
      const retryDelayMs = slackRateLimitRetryDelayMs(err);
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
  const threadTs = slackThreadTsFromThreadId(input.options.threadId);

  const externalMessageIds: string[] = [];
  // prettier-ignore
  const oversizedCtx = { app: input.app, channelId: input.channelId, threadTs, options: input.options, jid: input.jid, warnings, log: input.log, externalMessageIds };
  let deliveredParts = 0;
  for (let partIndex = 0; partIndex < parts.length; partIndex += 1) {
    const part = parts[partIndex];
    const actionBlocks =
      partIndex === parts.length - 1
        ? slackActionBlocks(part, input.options)
        : undefined;
    try {
      const posted = await postSlackMessageWithRetry(
        input.app,
        {
          channel: input.channelId,
          text: part,
          ...(threadTs ? { thread_ts: threadTs } : {}),
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
          threadId: threadTs,
          reason: 'payload_too_large',
        });
        if (fallback) {
          warnings.push('slack.snippet_fallback');
          if (fallback.externalMessageId) {
            externalMessageIds.push(fallback.externalMessageId);
          }
          await postActionsFollowUpNonFatal(oversizedCtx, warnings);
          const ids = [...externalMessageIds];
          return {
            ...(ids[0] ? { externalMessageId: ids[0] } : {}),
            ...(ids.length > 0 ? { externalMessageIds: ids } : {}),
            deliveredParts: parts.length,
            totalParts: parts.length,
            warnings,
            fallbackArtifactId: fallback.fallbackArtifactId,
          };
        }
        try {
          await deliverOversizedSlackPart({
            ...oversizedCtx,
            part,
            partIndex,
            totalParts: parts.length,
          });
          if (partIndex === parts.length - 1) {
            await postActionsFollowUpNonFatal(oversizedCtx, warnings);
          }
        } catch (resplitErr) {
          if (externalMessageIds.length > 0) {
            const remainder =
              typeof (resplitErr as { slackResplitRemainder?: string })
                .slackResplitRemainder === 'string'
                ? (resplitErr as { slackResplitRemainder: string })
                    .slackResplitRemainder
                : '';
            throw buildPartialSlackDelivery({
              cause: resplitErr,
              deliveredParts,
              totalParts: parts.length,
              externalMessageIds,
              unsentTail: remainder + parts.slice(partIndex + 1).join(''),
              channelId: input.channelId,
              threadTs,
            });
          }
          throw resplitErr;
        }
        deliveredParts += 1;
        continue;
      }
      if (deliveredParts > 0) {
        throw buildPartialSlackDelivery({
          cause: err,
          deliveredParts,
          totalParts: parts.length,
          externalMessageIds,
          unsentTail: parts.slice(deliveredParts).join(''),
          channelId: input.channelId,
          threadTs,
          warnings,
        });
      }
      throw err;
    }
  }

  await uploadSlackAttachments({
    app: input.app,
    jid: input.jid,
    channelId: input.channelId,
    threadTs,
    files: input.options.files,
    warnings,
    externalMessageIds,
    log: input.log,
    postSlackMessageWithRetry,
  });

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
  shouldContinue: () => boolean;
}): Promise<void> {
  if (!input.app) throw new Error('Slack app not initialized');
  const threadTs = slackThreadTsFromThreadId(input.state.threadId);
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
    if (!input.shouldContinue()) return;
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
          ...(threadTs ? { thread_ts: threadTs } : {}),
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
          provider: 'slack',
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
                      ? { threadId: threadTs ?? input.state.threadId }
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
}): Promise<boolean> {
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
    return false;
  }
  const actionOnly = Boolean(
    input.options.actionOnly && input.options.actionAffordances?.length,
  );
  const trimmed = actionOnly ? '' : input.text.trim();
  if (
    await handleSlackThreadProgressStatus({
      app: input.app,
      channelId: input.channelId,
      key: input.key,
      text: input.text,
      options: input.options,
      onDone: () => {
        input.activeProgress.delete(input.key);
        input.persistProgress();
      },
    })
  )
    return true;
  if (actionOnly) return false;
  if (!trimmed) {
    if (input.options.done) {
      input.activeProgress.delete(input.key);
      input.persistProgress();
    }
    return false;
  }
  let existing = input.activeProgress.get(input.key);
  const threadTs = slackThreadTsFromThreadId(input.options.threadId);
  if (
    existing &&
    (existing.channelId !== input.channelId || existing.threadId !== threadTs)
  ) {
    logger.warn(
      {
        channelId: input.channelId,
        key: input.key,
        storedChannelId: existing.channelId,
        storedThreadId: existing.threadId,
        expectedThreadId: threadTs,
      },
      'Progress lifecycle slack dropped mismatched persisted handle',
    );
    input.activeProgress.delete(input.key);
    input.persistProgress();
    existing = undefined;
  }
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
  existing = await currentProcessSlackProgress(input, existing);
  if (rejectOlderSlackProgressGeneration(input, existing)) return false;
  if (
    existing &&
    input.options.generation !== undefined &&
    existing.generation !== undefined &&
    existing.generation !== input.options.generation
  ) {
    if (!input.options.done && !input.options.replaceOnly) {
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
      existing = undefined;
    }
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
    return false;
  }
  if (!existing && input.options.done && isSlackTerminalSuccessText(trimmed)) {
    input.activeProgress.delete(input.key);
    input.persistProgress();
    return true;
  }
  if (!existing) {
    const blocks = slackActionBlocks(trimmed, input.options);
    const sent = (await input.app.client.chat.postMessage({
      channel: input.channelId,
      text: trimmed,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      ...(blocks ? { blocks } : {}),
    })) as { ts?: string };
    if (!input.options.done) {
      input.activeProgress.set(input.key, {
        channelId: input.channelId,
        threadId: threadTs,
        messageTs: sent.ts,
        lastText: trimmed,
        ownerBootNonce: slackProgressBootNonce,
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
    return true;
  }
  if (existing.lastText === trimmed) {
    if (input.options.done) {
      if (existing.messageTs) {
        await input.app.client.chat.update({
          channel: existing.channelId,
          ts: existing.messageTs,
          text: trimmed,
          blocks: [],
        });
      }
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
      if (input.options.generation !== undefined) {
        existing.generation = input.options.generation;
        input.activeProgress.set(input.key, existing);
        input.persistProgress();
      }
      logger.info(
        {
          channelId: input.channelId,
          key: input.key,
          generation: input.options.generation,
        },
        'Progress lifecycle slack skipped unchanged text',
      );
    }
    return true;
  }

  if (existing.messageTs) {
    const blocks = slackActionBlocks(trimmed, input.options);
    await input.app.client.chat.update({
      channel: existing.channelId,
      ts: existing.messageTs,
      text: trimmed,
      ...(blocks ? { blocks } : { blocks: [] }),
    });
  } else {
    const existingThreadTs = slackThreadTsFromThreadId(existing.threadId);
    const blocks = slackActionBlocks(trimmed, input.options);
    const sent = (await input.app.client.chat.postMessage({
      channel: existing.channelId,
      text: trimmed,
      ...(existingThreadTs ? { thread_ts: existingThreadTs } : {}),
      ...(blocks ? { blocks } : {}),
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
  return true;
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
      typeof state.lastText === 'string' &&
      (state.ownerBootNonce === undefined ||
        typeof state.ownerBootNonce === 'string')
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

export function resolveSlackDisconnectQuestions(input: {
  pendingUserQuestions: Map<string, PendingUserQuestionState>;
}): void {
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
  pendingUserQuestions: Map<string, PendingUserQuestionState>;
  stopNativeStream: (channelId: string, streamTs: string) => Promise<boolean>;
}): Promise<App | null> {
  resolveSlackDisconnectQuestions({
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
  onChatMetadata: OnChatMetadata;
  providerAccountId?: string;
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
        { providerAccountId: input.providerAccountId },
      );
    }

    const nextCursor = page.response_metadata?.next_cursor?.trim() || '';
    cursor = nextCursor || undefined;
  } while (cursor);
}
