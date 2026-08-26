import type { App } from '@slack/bolt';
import type { ProgressUpdateOptions } from '../../domain/types.js';
import { canonicalJson } from '../../shared/canonical-json.js';
import {
  slackJobNotificationBlocks,
  slackMessageActionBlocks,
} from './message-action-affordances.js';

type SlackProgressApp = App;

export function slackProgressPresentation(
  text: string,
  options: ProgressUpdateOptions,
  standardBlocks?: Array<Record<string, unknown>>,
): {
  blocks?: Array<Record<string, unknown>>;
  contentKey: string;
  fallbackBlocks?: Array<Record<string, unknown>>;
  structuredTerminal: boolean;
} {
  const structuredTerminal = Boolean(
    options.done && options.jobNotificationView,
  );
  const blocks = structuredTerminal
    ? slackJobNotificationBlocks(
        options.jobNotificationView!,
        options.actionAffordances,
        { providerAccountId: options.providerAccountId },
      )
    : standardBlocks;
  const fallbackBlocks =
    structuredTerminal && options.actionAffordances?.length
      ? slackMessageActionBlocks(text, options.actionAffordances, {
          actionOnly: true,
          providerAccountId: options.providerAccountId,
        })
      : undefined;
  return {
    ...(blocks ? { blocks } : {}),
    contentKey: blocks ? canonicalJson(blocks) : text,
    ...(fallbackBlocks ? { fallbackBlocks } : {}),
    structuredTerminal,
  };
}

const SLACK_BLOCK_REJECTION_CODES = new Set([
  'invalid_blocks',
  'invalid_blocks_format',
  'invalid_arguments',
]);

export function isSlackBlockRejection(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const error = err as {
    code?: unknown;
    data?: { error?: unknown };
    message?: unknown;
  };
  const code = error.code;
  const dataError = error.data?.error;
  const message = error.message;
  return (
    [code, dataError, message].some(
      (value) =>
        typeof value === 'string' && SLACK_BLOCK_REJECTION_CODES.has(value),
    ) ||
    (typeof message === 'string' && message.includes('invalid_blocks'))
  );
}

export async function postSlackProgressWithStructuredFallback(input: {
  app: SlackProgressApp;
  channelId: string;
  text: string;
  threadTs?: string;
  blocks?: Array<Record<string, unknown>>;
  fallbackBlocks?: Array<Record<string, unknown>>;
  structuredTerminal: boolean;
}): Promise<{ ts?: string }> {
  const payload = {
    channel: input.channelId,
    text: input.text,
    ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
  };
  try {
    return (await input.app.client.chat.postMessage({
      ...payload,
      ...(input.blocks ? { blocks: input.blocks } : {}),
    })) as { ts?: string };
  } catch (err) {
    if (!input.structuredTerminal || !isSlackBlockRejection(err)) throw err;
    return (await input.app.client.chat.postMessage({
      ...payload,
      ...(input.fallbackBlocks ? { blocks: input.fallbackBlocks } : {}),
    })) as {
      ts?: string;
    };
  }
}

export async function updateSlackProgressWithStructuredFallback(input: {
  app: SlackProgressApp;
  channelId: string;
  messageTs: string;
  text: string;
  blocks?: Array<Record<string, unknown>>;
  fallbackBlocks?: Array<Record<string, unknown>>;
  structuredTerminal: boolean;
}): Promise<void> {
  const payload = {
    channel: input.channelId,
    ts: input.messageTs,
    text: input.text,
  };
  try {
    await input.app.client.chat.update({
      ...payload,
      ...(input.blocks ? { blocks: input.blocks } : { blocks: [] }),
    });
  } catch (err) {
    if (!input.structuredTerminal || !isSlackBlockRejection(err)) throw err;
    await input.app.client.chat.update({
      ...payload,
      ...(input.fallbackBlocks
        ? { blocks: input.fallbackBlocks }
        : { blocks: [] }),
    });
  }
}
