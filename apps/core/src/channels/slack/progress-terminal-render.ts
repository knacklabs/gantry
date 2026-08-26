import type { App } from '@slack/bolt';
import type { ProgressUpdateOptions } from '../../domain/types.js';
import { canonicalJson } from '../../shared/canonical-json.js';
import { slackJobNotificationBlocks } from './message-action-affordances.js';

type SlackProgressApp = App;

export function slackProgressPresentation(
  text: string,
  options: ProgressUpdateOptions,
  standardBlocks?: Array<Record<string, unknown>>,
): {
  blocks?: Array<Record<string, unknown>>;
  contentKey: string;
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
  return {
    ...(blocks ? { blocks } : {}),
    contentKey: blocks ? canonicalJson(blocks) : text,
    structuredTerminal,
  };
}

export async function postSlackProgressWithStructuredFallback(input: {
  app: SlackProgressApp;
  channelId: string;
  text: string;
  threadTs?: string;
  blocks?: Array<Record<string, unknown>>;
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
    if (!input.structuredTerminal) throw err;
    return (await input.app.client.chat.postMessage(payload)) as {
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
    if (!input.structuredTerminal) throw err;
    await input.app.client.chat.update({ ...payload, blocks: [] });
  }
}
