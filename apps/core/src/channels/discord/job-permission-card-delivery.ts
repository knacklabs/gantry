import type {
  MessageDeliveryResult,
  MessageSendOptions,
} from '../../domain/types.js';
import { PartialMessageDeliveryError } from '../../domain/messages/partial-delivery.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { JobPermissionCardDeliverySettlement } from '../interaction-settlement.js';
import { settleJobPermissionCardRetire } from '../job-permission-card-settlement.js';
import { splitDiscordText } from './delivery.js';

type DiscordMessageMutations = {
  delete(channelId: string, messageId: string): Promise<void>;
  edit(
    channelId: string,
    messageId: string,
    body: Record<string, unknown>,
  ): Promise<void>;
};

const deliveriesByMutations = new WeakMap<
  DiscordMessageMutations,
  JobPermissionCardDeliverySettlement
>();

export function retireDiscordCard(
  channelId: string,
  text: string,
  options: MessageSendOptions,
  messageMutations: DiscordMessageMutations,
): Promise<MessageDeliveryResult> {
  const deliveries =
    deliveriesByMutations.get(messageMutations) ??
    new JobPermissionCardDeliverySettlement();
  deliveriesByMutations.set(messageMutations, deliveries);
  const providerMessageId = options.deleteMessageId ?? options.replaceMessageId;
  if (!providerMessageId) {
    throw new Error('Discord retired job permission card has no message id.');
  }
  const partialFallback = (cause: unknown, deleteFailedAt: string) => {
    const partial = new PartialMessageDeliveryError({
      cause,
      deliveredChunks: 1,
      name: 'PartialDiscordJobPermissionCardRetireError',
      message: 'Discord card delete failed; receipt edit remains pending',
      totalChunks: 2,
    });
    Object.assign(partial, {
      provider: 'discord',
      deliveredParts: 1,
      totalParts: 2,
      externalMessageIds: [providerMessageId],
      retryTail: {
        canonicalText: text,
        providerPayload: {
          provider: 'discord',
          channelId,
          jobPermissionCard: {
            ...options.jobPermissionCardRevision,
            providerMessageId,
            retireDelivery: { deleteFailedAt },
            actions: [],
          },
        },
      },
    });
    return partial;
  };
  return settleJobPermissionCardRetire({
    deliveries,
    scope: channelId,
    providerMessageId,
    options,
    ...(options.deleteMessageId
      ? {
          deleteMessage: () =>
            messageMutations.delete(channelId, providerMessageId),
        }
      : {}),
    deliverReceipt: async () => {
      const parts = splitDiscordText(text);
      if (parts.length !== 1 || options.files?.length) {
        throw new Error(
          'Discord retired job permission card must fit one message without files.',
        );
      }
      await messageMutations.edit(channelId, providerMessageId, {
        content: parts[0] ?? '',
        allowed_mentions: { parse: [] },
        components: [],
        embeds: [],
      });
      return providerMessageId;
    },
    onDeleteFailure: (error, deleteFailedAt) => {
      logger.warn(
        {
          channelId,
          messageId: providerMessageId,
          error: error instanceof Error ? error.message : 'unknown',
        },
        'Failed to delete approved Discord job permission card; receipt edit queued',
      );
      throw partialFallback(error, deleteFailedAt);
    },
    pendingReceiptError: partialFallback,
  });
}
