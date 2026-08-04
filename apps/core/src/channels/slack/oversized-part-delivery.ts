import type { MessageSendOptions } from '../../domain/types.js';
import { PartialMessageDeliveryError } from '../../domain/messages/partial-delivery.js';
export function buildPartialSlackDelivery(args: {
  cause: unknown;
  deliveredParts: number;
  totalParts: number;
  externalMessageIds: string[];
  unsentTail: string;
  channelId: string;
  threadTs: string | undefined;
  warnings?: string[];
}): PartialMessageDeliveryError {
  const partial = new PartialMessageDeliveryError({
    cause: args.cause,
    deliveredChunks: args.deliveredParts,
    name: 'PartialSlackDeliveryError',
    message: `Slack message partially delivered (${args.deliveredParts}/${args.totalParts} parts)`,
    totalChunks: args.totalParts,
  });
  Object.assign(partial, {
    provider: 'slack',
    deliveredParts: args.deliveredParts,
    totalParts: args.totalParts,
    externalMessageIds: args.externalMessageIds,
    ...(args.unsentTail.trim()
      ? {
          retryTail: {
            canonicalText: args.unsentTail,
            providerPayload: {
              provider: 'slack',
              channelId: args.channelId,
              ...(args.threadTs ? { threadId: args.threadTs } : {}),
            },
          },
        }
      : {}),
    ...(args.warnings && args.warnings.length > 0
      ? { warnings: args.warnings }
      : {}),
  });
  return partial;
}

import type { App } from '@slack/bolt';

import { splitSlackTextByCodeUnits } from './text-limits.js';
import { isSlackPayloadTooLarge } from './file-delivery.js';
import {
  postSlackMessageWithRetry,
  slackActionBlocks,
  type SlackDeliveryLogger,
} from './channel-delivery-helpers.js';

// 413 is deterministic — never replay the same payload. Process a queue so
// repeatedly rejected halves keep splitting until they fit or cannot shrink
// further (then the error is genuine and escapes).
export async function deliverOversizedSlackPart(input: {
  app: App;
  channelId: string;
  threadTs: string | undefined;
  part: string;
  jid: string;
  partIndex: number;
  totalParts: number;
  warnings: string[];
  log: SlackDeliveryLogger;
  externalMessageIds: string[];
}): Promise<void> {
  const queue = splitSlackTextByCodeUnits(
    input.part,
    Math.max(1, Math.ceil(input.part.length / 2)),
  );
  input.warnings.push(`slack.part_resplit:${queue.length}`);
  let subPosted = 0;
  while (queue.length > 0) {
    const subPart = queue.shift()!;
    try {
      const posted = await postSlackMessageWithRetry(
        input.app,
        {
          channel: input.channelId,
          text: subPart,
          ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
        },
        {
          jid: input.jid,
          part: input.partIndex + 1,
          totalParts: input.totalParts + subPosted,
        },
        input.warnings,
        input.log,
      );
      if (posted.ts) input.externalMessageIds.push(posted.ts);
      subPosted += 1;
    } catch (subErr) {
      if (!isSlackPayloadTooLarge(subErr) || subPart.length <= 1) {
        // Preserve the exact unsent remainder for partial-delivery handling.
        Object.assign(subErr as object, {
          slackResplitRemainder: subPart + queue.join(''),
        });
        throw subErr;
      }
      queue.unshift(
        ...splitSlackTextByCodeUnits(
          subPart,
          Math.max(1, Math.ceil(subPart.length / 2)),
        ),
      );
    }
  }
}

export async function postOversizedActionsFollowUp(input: {
  app: App;
  channelId: string;
  threadTs: string | undefined;
  options: MessageSendOptions;
  jid: string;
  warnings: string[];
  log: SlackDeliveryLogger;
  externalMessageIds: string[];
}): Promise<void> {
  // Oversized paths deliver text without blocks; actions arrive as one small
  // follow-up so interactions never disappear and never exceed limits.
  const label = 'Actions for the message above:';
  const blocks = slackActionBlocks(label, input.options);
  if (!blocks) return;
  const posted = await postSlackMessageWithRetry(
    input.app,
    {
      channel: input.channelId,
      text: label,
      ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
      blocks,
    },
    { jid: input.jid, part: 1, totalParts: 1 },
    input.warnings,
    input.log,
  );
  if (posted.ts) input.externalMessageIds.push(posted.ts);
}

// Deliberate: the send is already delivered; a fatal follow-up error would
// make retries duplicate the artifact. The warning marker suffices.
export async function postActionsFollowUpNonFatal(
  ctx: Parameters<typeof postOversizedActionsFollowUp>[0],
  warnings: string[],
): Promise<void> {
  try {
    await postOversizedActionsFollowUp(ctx);
  } catch {
    warnings.push('slack.actions_followup_failed');
  }
}
