import type {
  MessageDeliveryResult,
  MessageSendOptions,
} from '../domain/types.js';
import type { JobPermissionCardDeliverySettlement } from './interaction-settlement.js';

type RetireDelivery = NonNullable<
  MessageDeliveryResult['jobPermissionCardRetireDelivery']
>;
const retireDeliveries = new WeakMap<
  JobPermissionCardDeliverySettlement,
  Map<string, RetireDelivery>
>();

export function singleMessageDeliveryResult(
  messageId: string,
): MessageDeliveryResult {
  return {
    externalMessageId: messageId,
    externalMessageIds: [messageId],
    deliveredParts: 1,
    totalParts: 1,
  };
}

export async function settleJobPermissionCardRetire(input: {
  deliveries: JobPermissionCardDeliverySettlement;
  scope: string;
  providerMessageId?: string;
  options: MessageSendOptions;
  deleteMessage?: () => Promise<void>;
  deliverReceipt: () => Promise<string>;
  onDeleteFailure?: (error: unknown, deleteFailedAt: string) => void;
  pendingReceiptError?: (error: unknown, deleteFailedAt: string) => Error;
}): Promise<MessageDeliveryResult> {
  const { deliveries, scope, providerMessageId, options } = input;
  const cardRevision = options.jobPermissionCardRevision;
  if (
    !cardRevision ||
    cardRevision.operation !== 'retire' ||
    (cardRevision.retireOutcome !== 'allowed' &&
      cardRevision.retireOutcome !== 'expired')
  ) {
    throw new Error('Job permission card retirement is invalid.');
  }
  const revision = {
    ...cardRevision,
    callbackKey: `${scope}:${cardRevision.callbackKey}`,
  };
  const persisted = cardRevision.retireDelivery;
  const settledDeliveries = retireDeliveries.get(deliveries) ?? new Map();
  retireDeliveries.set(deliveries, settledDeliveries);
  const finish = (messageId: string, retireDelivery: RetireDelivery) => {
    deliveries.record(revision, messageId, `${scope}:${messageId}`);
    settledDeliveries.set(revision.callbackKey, retireDelivery);
    return {
      ...singleMessageDeliveryResult(messageId),
      jobPermissionCardRetireDelivery: retireDelivery,
    };
  };
  if (persisted?.deletedAt || persisted?.receiptMessageId) {
    const messageId = persisted.receiptMessageId ?? providerMessageId;
    if (!messageId) throw new Error('Settled card has no provider message id.');
    return finish(messageId, persisted);
  }
  if (providerMessageId) {
    deliveries.bindMessage(
      `${scope}:${providerMessageId}`,
      revision.callbackKey,
    );
  }
  return deliveries.serialize(revision.callbackKey, async () => {
    const settledMessageId = deliveries.settledMessageId(revision);
    if (settledMessageId) {
      const settledDelivery = settledDeliveries.get(revision.callbackKey);
      if (settledDelivery) return finish(settledMessageId, settledDelivery);
      return finish(
        settledMessageId,
        cardRevision.retireOutcome === 'allowed' &&
          input.deleteMessage &&
          !persisted?.deleteFailedAt
          ? { deletedAt: new Date().toISOString() }
          : {
              ...(persisted?.deleteFailedAt
                ? { deleteFailedAt: persisted.deleteFailedAt }
                : {}),
              receiptMessageId: settledMessageId,
            },
      );
    }
    let deleteFailedAt = persisted?.deleteFailedAt;
    if (
      cardRevision.retireOutcome === 'allowed' &&
      input.deleteMessage &&
      !deleteFailedAt
    ) {
      try {
        await input.deleteMessage();
        if (!providerMessageId) {
          throw new Error('Deleted card has no provider message id.');
        }
        return finish(providerMessageId, {
          deletedAt: new Date().toISOString(),
        });
      } catch (error) {
        deleteFailedAt = new Date().toISOString();
        input.onDeleteFailure?.(error, deleteFailedAt);
      }
    }

    let receiptMessageId: string;
    try {
      receiptMessageId = await input.deliverReceipt();
    } catch (error) {
      if (deleteFailedAt && input.pendingReceiptError) {
        throw input.pendingReceiptError(error, deleteFailedAt);
      }
      throw error;
    }
    return finish(receiptMessageId, {
      ...(deleteFailedAt ? { deleteFailedAt } : {}),
      receiptMessageId,
    });
  });
}
