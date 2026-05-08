import type { OutboundDeliveryService } from '../../application/outbound-delivery/outbound-delivery-service.js';
import type { DurableOutboundAttempt } from './channel-wiring-types.js';

interface ClaimedLiveSendItem {
  itemId: string;
  claimToken: string;
}

export function createDurableOutboundAttempt(input: {
  outboundDeliveryService: OutboundDeliveryService;
  deliveryId: string;
  claimedItems: ClaimedLiveSendItem[];
  sourceMessageId: string;
}): DurableOutboundAttempt {
  let nextUnsettledIndex = 0;

  const settleRemainingAsAmbiguous = async (settleInput: {
    fromIndex: number;
    partialAt: string;
    error: string;
  }) => {
    for (
      let index = settleInput.fromIndex;
      index < input.claimedItems.length;
      index += 1
    ) {
      const claimedItem = input.claimedItems[index]!;
      const settled =
        await input.outboundDeliveryService.settlePartiallyDelivered({
          deliveryId: input.deliveryId as never,
          itemId: claimedItem.itemId as never,
          claimToken: claimedItem.claimToken,
          error: settleInput.error,
          partialAt: settleInput.partialAt,
        });
      if (!settled.applied) {
        throw new Error(
          `Durable outbound ambiguous settlement was not applied for ${input.deliveryId} item ${claimedItem.itemId}.`,
        );
      }
      nextUnsettledIndex = index + 1;
    }
  };

  return {
    settleSent: async (settleInput) => {
      for (
        let index = nextUnsettledIndex;
        index < input.claimedItems.length;
        index += 1
      ) {
        const claimedItem = input.claimedItems[index]!;
        try {
          const settled = await input.outboundDeliveryService.settleSent({
            deliveryId: input.deliveryId as never,
            itemId: claimedItem.itemId as never,
            claimToken: claimedItem.claimToken,
            receiptIdempotencyKey: `live-send:${input.sourceMessageId}:receipt:${index}`,
            providerMessageId: settleInput.providerMessageId,
            providerPayload: settleInput.providerPayload,
            sentAt: settleInput.sentAt,
          });
          if (!settled.applied) {
            throw new Error(
              `Durable outbound sent settlement was not applied for ${input.deliveryId} item ${claimedItem.itemId}.`,
            );
          }
          nextUnsettledIndex = index + 1;
          continue;
        } catch (err) {
          const ambiguousError = `Provider send succeeded but durable sent settlement failed for split segment ${index + 1}/${input.claimedItems.length}; remaining unsettled segments were marked non-retryable to prevent duplicate provider sends.`;
          await settleRemainingAsAmbiguous({
            fromIndex: index,
            partialAt: settleInput.sentAt,
            error: ambiguousError,
          });
          throw err;
        }
      }
    },
    settleFailed: async (settleInput) => {
      for (
        let index = nextUnsettledIndex;
        index < input.claimedItems.length;
        index += 1
      ) {
        const claimedItem = input.claimedItems[index]!;
        const settled = await input.outboundDeliveryService.settleFailed({
          deliveryId: input.deliveryId as never,
          itemId: claimedItem.itemId as never,
          claimToken: claimedItem.claimToken,
          error: settleInput.error,
          failedAt: settleInput.failedAt,
          maxAttempts: 4,
          retryBaseDelayMs: 1_000,
          retryMaxDelayMs: 30_000,
        });
        if (!settled.applied) {
          throw new Error(
            `Durable outbound failed settlement was not applied for ${input.deliveryId}.`,
          );
        }
        nextUnsettledIndex = index + 1;
      }
    },
    settlePartiallyDelivered: async (settleInput) => {
      if (nextUnsettledIndex >= input.claimedItems.length) {
        return;
      }
      const firstClaimedItem = input.claimedItems[nextUnsettledIndex]!;
      const settled =
        await input.outboundDeliveryService.settlePartiallyDelivered({
          deliveryId: input.deliveryId as never,
          itemId: firstClaimedItem.itemId as never,
          claimToken: firstClaimedItem.claimToken,
          error: settleInput.error,
          partialAt: settleInput.partialAt,
          deliveredParts: settleInput.deliveredParts,
          totalParts: settleInput.totalParts,
          retryTail: settleInput.retryTail,
        });
      if (!settled.applied) {
        throw new Error(
          `Durable outbound partial settlement was not applied for ${input.deliveryId}.`,
        );
      }
      nextUnsettledIndex += 1;
      for (
        let index = nextUnsettledIndex;
        index < input.claimedItems.length;
        index += 1
      ) {
        const claimedItem = input.claimedItems[index]!;
        const terminalFailure =
          await input.outboundDeliveryService.settleFailed({
            deliveryId: input.deliveryId as never,
            itemId: claimedItem.itemId as never,
            claimToken: claimedItem.claimToken,
            error: settleInput.error,
            failedAt: settleInput.partialAt,
            maxAttempts: 1,
            retryBaseDelayMs: 1,
            retryMaxDelayMs: 1,
          });
        if (!terminalFailure.applied) {
          throw new Error(
            `Durable outbound residual item settlement was not applied for ${input.deliveryId}.`,
          );
        }
        nextUnsettledIndex = index + 1;
      }
    },
  };
}
