import { logger } from '../infrastructure/logging/logger.js';
import type { NewMessage } from '../domain/types.js';
import {
  InboundMessageDeliveryError,
  type ChannelOpts,
  type MaterializeProviderAttachment,
} from './channel-provider.js';
import { discordMessageAttachments } from './discord-conversation-context.js';
import {
  abortableReader,
  fetchDiscordCdnAttachment,
} from './discord-historical-attachment-fetcher.js';
import type { DiscordMessageCreate } from './discord-types.js';

type DiscordAttachments = NonNullable<
  ReturnType<typeof discordMessageAttachments>
>;

export const DISCORD_LIVE_ATTACHMENT_DEADLINE_MS = 110_000;

export async function captureLiveDiscordAttachments(input: {
  message: DiscordMessageCreate;
  attachments: DiscordAttachments;
  materialize?: MaterializeProviderAttachment;
  deadlineMs?: number;
}): Promise<{
  attachments: DiscordAttachments;
  reclaim: Array<() => Promise<void>>;
}> {
  if (!input.materialize || input.attachments.length === 0) {
    return { attachments: input.attachments, reclaim: [] };
  }
  const captured: DiscordAttachments = [];
  const reclaim: Array<() => Promise<void>> = [];
  for (const attachment of input.attachments) {
    const providerAttachment = input.message.attachments?.find(
      (candidate) => candidate.id === attachment.externalId,
    );
    if (!providerAttachment?.url) {
      captured.push(attachment);
      continue;
    }
    try {
      const materialized = await captureAttachmentWithinDeadline({
        url: providerAttachment.url,
        fileName: providerAttachment.filename || 'attachment.bin',
        materialize: input.materialize,
        deadlineMs: input.deadlineMs ?? DISCORD_LIVE_ATTACHMENT_DEADLINE_MS,
      });
      if (!materialized) {
        captured.push(attachment);
        continue;
      }
      captured.push({ ...attachment, storageRef: materialized.storageRef });
      reclaim.push(materialized.reclaim);
    } catch {
      logger.warn(
        { attachmentId: providerAttachment.id },
        'Discord attachment capture failed',
      );
      captured.push(attachment);
    }
  }
  return { attachments: captured, reclaim };
}

async function captureAttachmentWithinDeadline(input: {
  url: string;
  fileName: string;
  materialize: MaterializeProviderAttachment;
  deadlineMs: number;
}) {
  const controller = new AbortController();
  let expired = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const capture = (async () => {
    const response = await fetchDiscordCdnAttachment(
      input.url,
      controller.signal,
    );
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    return input.materialize({
      fileName: input.fileName,
      content: abortableReader(response.body.getReader(), controller.signal),
    });
  })();
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      expired = true;
      controller.abort(
        new DOMException('Discord attachment deadline', 'AbortError'),
      );
      reject(new Error('Discord attachment capture deadline exceeded'));
    }, input.deadlineMs);
  });
  try {
    return await Promise.race([capture, deadline]);
  } finally {
    if (timeout) clearTimeout(timeout);
    controller.abort();
    if (expired) {
      void capture
        .then((materialized) => materialized?.reclaim())
        .catch(() => undefined);
    }
  }
}

export async function reclaimDiscordAttachments(
  reclaim: Array<() => Promise<void>>,
  deliveryError?: unknown,
): Promise<void> {
  const results = await Promise.allSettled(reclaim.map((remove) => remove()));
  const cleanupErrors = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : [],
  );
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      deliveryError === undefined
        ? cleanupErrors
        : [deliveryError, ...cleanupErrors],
      'Failed to reclaim Discord attachment materializations',
    );
  }
}

export async function deliverLiveDiscordMessage(input: {
  opts: Pick<
    ChannelOpts,
    | 'ensureMessageRoute'
    | 'materializeProviderAttachment'
    | 'onChatMetadata'
    | 'onMessage'
    | 'providerAccountId'
  >;
  message: DiscordMessageCreate;
  conversationJid: string;
  inboundMessage: NewMessage;
  attachments: DiscordAttachments;
  metadataName?: string;
  needsStandaloneMetadataWrite: boolean;
}): Promise<void> {
  if (
    input.opts.ensureMessageRoute &&
    !(await input.opts.ensureMessageRoute(
      input.conversationJid,
      input.inboundMessage,
    ))
  ) {
    return;
  }
  if (input.needsStandaloneMetadataWrite) {
    const metadataArgs = [
      input.conversationJid,
      input.message.timestamp || new Date().toISOString(),
      input.metadataName,
      'discord',
      true,
    ] as const;
    if (input.opts.providerAccountId) {
      await input.opts.onChatMetadata(...metadataArgs, {
        providerAccountId: input.opts.providerAccountId,
      });
    } else {
      await input.opts.onChatMetadata(...metadataArgs);
    }
  }
  const captured = await captureLiveDiscordAttachments({
    message: input.message,
    attachments: input.attachments,
    materialize: input.opts.materializeProviderAttachment,
  });
  const deliveredMessage = {
    ...input.inboundMessage,
    ...(captured.attachments.length > 0
      ? { attachments: captured.attachments }
      : {}),
  };
  try {
    const result = await input.opts.onMessage(
      input.conversationJid,
      deliveredMessage,
    );
    if (result === 'stored') return;
  } catch (error) {
    if (!(error instanceof InboundMessageDeliveryError && error.stored)) {
      await reclaimDiscordAttachments(captured.reclaim, error);
    }
    throw error;
  }
  await reclaimDiscordAttachments(captured.reclaim);
}
