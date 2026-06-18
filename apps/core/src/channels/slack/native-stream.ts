import type { App } from '@slack/bolt';
import { PartialMessageDeliveryError } from '../../domain/messages/partial-delivery.js';
import { logger } from '../../infrastructure/logging/logger.js';
import {
  SLACK_NATIVE_APPEND_MAX_LENGTH,
  splitSlackTextByCodeUnits,
} from './text-limits.js';
import {
  clampSlackRetryDelayMs,
  slackRateLimitRetryDelayMs,
} from './channel-retry-delay.js';

async function waitForRetry(delayMs: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, clampSlackRetryDelayMs(delayMs));
  });
}

export async function tryNativeStreamStart(input: {
  app: App | null;
  channelId: string;
  threadId: string | undefined;
  text: string;
}): Promise<string | undefined> {
  if (!input.app) return undefined;
  try {
    const result = (await input.app.client.apiCall('chat.startStream', {
      channel: input.channelId,
      ...(input.threadId ? { thread_ts: input.threadId } : {}),
      markdown_text: input.text,
    })) as { ok?: boolean; ts?: string; stream_ts?: string };
    if (!result.ok) return undefined;
    return result.stream_ts || result.ts;
  } catch {
    return undefined;
  }
}

export async function tryNativeStreamAppend(input: {
  app: App | null;
  channelId: string;
  streamTs: string;
  text: string;
}): Promise<{ completed: boolean; sentPrefix: string }> {
  if (!input.app || !input.text.trim()) {
    return { completed: true, sentPrefix: '' };
  }
  const chunks = splitSlackTextByCodeUnits(
    input.text,
    SLACK_NATIVE_APPEND_MAX_LENGTH,
  );
  if (chunks.length > 1) {
    logger.warn(
      {
        channelId: input.channelId,
        streamTs: input.streamTs,
        parts: chunks.length,
        limit: SLACK_NATIVE_APPEND_MAX_LENGTH,
      },
      'Slack streaming append split to respect payload limits',
    );
  }
  let sentPrefix = '';
  let appendedChunks = 0;
  for (const chunk of chunks) {
    let appended = false;
    let lastFailure: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = (await input.app.client.apiCall('chat.appendStream', {
          channel: input.channelId,
          ts: input.streamTs,
          markdown_text: chunk,
        })) as { ok?: boolean; error?: string; retry_after?: number };
        if (result.ok === true) {
          appended = true;
          break;
        }
        const retryDelayMs = slackRateLimitRetryDelayMs(result);
        if (retryDelayMs === null || attempt >= 2) {
          lastFailure = result;
          break;
        }
        logger.warn(
          {
            channelId: input.channelId,
            streamTs: input.streamTs,
            attempt: attempt + 1,
            retryDelayMs,
          },
          'Slack append stream rate-limited; retrying',
        );
        await waitForRetry(retryDelayMs);
      } catch (err) {
        const retryDelayMs = slackRateLimitRetryDelayMs(err);
        if (retryDelayMs === null || attempt >= 2) {
          lastFailure = err;
          break;
        }
        logger.warn(
          {
            channelId: input.channelId,
            streamTs: input.streamTs,
            attempt: attempt + 1,
            retryDelayMs,
          },
          'Slack append stream errored with rate limit; retrying',
        );
        await waitForRetry(retryDelayMs);
      }
    }
    if (!appended) {
      if (appendedChunks > 0) {
        const partial = new PartialMessageDeliveryError({
          cause: lastFailure ?? new Error('Slack native stream append failed'),
          deliveredChunks: appendedChunks,
          name: 'PartialSlackNativeStreamAppendDeliveryError',
          message: `Slack native stream append partially delivered (${appendedChunks}/${chunks.length} chunks)`,
          totalChunks: chunks.length,
        });
        Object.assign(partial, {
          provider: 'slack',
          deliveredParts: appendedChunks,
          totalParts: chunks.length,
          sentPrefix,
          warnings: ['slack.native_stream_append_partial_delivery'],
        });
        throw partial;
      }
      return { completed: false, sentPrefix };
    }
    sentPrefix += chunk;
    appendedChunks += 1;
  }
  return { completed: true, sentPrefix };
}

export async function tryNativeStreamStop(input: {
  app: App | null;
  channelId: string;
  streamTs: string;
}): Promise<boolean> {
  if (!input.app) return true;
  try {
    const result = (await input.app.client.apiCall('chat.stopStream', {
      channel: input.channelId,
      ts: input.streamTs,
    })) as { ok?: boolean };
    return result.ok === true;
  } catch {
    return false;
  }
}
