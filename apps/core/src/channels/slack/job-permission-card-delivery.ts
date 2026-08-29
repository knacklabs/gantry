import type { App } from '@slack/bolt';
import type {
  MessageDeliveryResult,
  MessageSendOptions,
} from '../../domain/types.js';
import { PartialMessageDeliveryError } from '../../domain/messages/partial-delivery.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { JobPermissionCardDeliverySettlement } from '../interaction-settlement.js';
import { settleJobPermissionCardRetire } from '../job-permission-card-settlement.js';
import { runSlackMutationWithRetry } from './channel-delivery-helpers.js';

const deliveriesByApp = new WeakMap<App, JobPermissionCardDeliverySettlement>();

export function retireSlackCard(
  app: App,
  channelId: string,
  text: string,
  options: MessageSendOptions,
): Promise<MessageDeliveryResult> {
  const deliveries =
    deliveriesByApp.get(app) ?? new JobPermissionCardDeliverySettlement();
  deliveriesByApp.set(app, deliveries);
  const providerMessageId = options.deleteMessageId ?? options.replaceMessageId;
  if (!providerMessageId) {
    throw new Error('Slack retired job permission card has no message id.');
  }
  const context = {
    channelId,
    messageId: providerMessageId,
  };
  const partialFallback = (cause: unknown, deleteFailedAt: string) => {
    const partial = new PartialMessageDeliveryError({
      cause,
      deliveredChunks: 1,
      name: 'PartialSlackJobPermissionCardRetireError',
      message: 'Slack card delete failed; receipt edit remains pending',
      totalChunks: 2,
    });
    Object.assign(partial, {
      provider: 'slack',
      deliveredParts: 1,
      totalParts: 2,
      externalMessageIds: [providerMessageId],
      retryTail: {
        canonicalText: text,
        providerPayload: {
          provider: 'slack',
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
          deleteMessage: async () => {
            await runSlackMutationWithRetry(
              () =>
                app.client.chat.delete({
                  channel: channelId,
                  ts: providerMessageId,
                }),
              'job permission card delete',
              context,
            );
          },
        }
      : {}),
    deliverReceipt: async () => {
      const updated = await runSlackMutationWithRetry(
        () =>
          app.client.chat.update({
            channel: channelId,
            ts: providerMessageId,
            text,
            blocks: [],
          }),
        'job permission card update',
        context,
      );
      return updated.ts ?? providerMessageId;
    },
    onDeleteFailure: (error, deleteFailedAt) => {
      logger.warn(
        {
          ...context,
          error: error instanceof Error ? error.message : 'unknown',
        },
        'Failed to delete approved Slack job permission card; receipt edit queued',
      );
      throw partialFallback(error, deleteFailedAt);
    },
    pendingReceiptError: partialFallback,
  });
}
