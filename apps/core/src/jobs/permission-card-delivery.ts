import type { OutboundDeliveryService } from '../application/outbound-delivery/outbound-delivery-service.js';
import type { PreparedPermissionCardSend } from '../domain/permission-card.js';
import type { ClaimedOutboundDeliveryItem } from '../domain/outbound-delivery/outbound-delivery.js';
import type { OutboundDeliveryDispatchResult } from './outbound-delivery-recovery.js';
import type { OutboundDeliveryProfile } from '../domain/outbound-delivery/planner.js';

export const SETUP_PERMISSION_CARD_PROFILE_ID = 'setup_permission_prompt';
export const setupPermissionCardProfile: OutboundDeliveryProfile = {
  profileId: SETUP_PERMISSION_CARD_PROFILE_ID,
  plan: (input) => ({
    parts: [{ canonicalText: input.text }],
    canonicalFinalText: input.text,
  }),
};

export async function dispatchPreparedPermissionCard(input: {
  service: OutboundDeliveryService;
  claimed: ClaimedOutboundDeliveryItem;
  now: () => string;
  prepare: (
    view: NonNullable<
      Awaited<
        ReturnType<
          OutboundDeliveryService['getSetupPermissionPromptForDispatch']
        >
      >
    >,
  ) => PreparedPermissionCardSend;
}): Promise<OutboundDeliveryDispatchResult | null> {
  const promptId = input.claimed.item.permissionPromptId;
  if (!promptId) return null;
  const view = await input.service.getSetupPermissionPromptForDispatch({
    appId: input.claimed.delivery.appId,
    promptId,
    now: input.now(),
  });
  if (!view) {
    // Failed revalidation = the target moved on (cancelled/superseded/
    // resumed). TERMINAL cancellation - never the failed/retry path.
    return {
      status: 'cancelled',
      reason: { code: 'prompt_not_dispatchable' },
    };
  }
  let prepared: PreparedPermissionCardSend;
  try {
    prepared = input.prepare(view);
  } catch (err) {
    return {
      status: 'failed',
      error: err instanceof Error ? err.message : String(err),
    };
  }
  const claimToken = input.claimed.item.claimToken;
  if (!claimToken) {
    return {
      status: 'failed',
      error: 'Permission card claim token is missing.',
    };
  }
  const begun = await input.service.beginSend({
    deliveryId: input.claimed.delivery.id,
    itemId: input.claimed.item.id,
    promptId,
    claimToken,
    begunAt: input.now(),
  });
  if (begun === 'prompt_closed') {
    // The fenced revalidation found the prompt no longer open: TERMINAL
    // cancellation, never a retry.
    return {
      status: 'cancelled',
      reason: { code: 'prompt_closed_at_checkpoint' },
    };
  }
  if (begun !== 'begun') {
    // lease_lost: the expired-claim sweep owns recovery (requeue + attempt
    // refund) - settling failed here would burn a transmission attempt.
    return { status: 'stale_claim' };
  }
  try {
    const sent = await prepared.send();
    return {
      status: 'sent',
      providerMessageId: sent.delivery.externalMessageId,
      providerPayload: sent.delivery,
      permissionPromptLocator: sent.locator,
    };
  } catch (err) {
    return {
      status: 'partially_delivered',
      error: `Permission card transmission may have occurred and cannot be retried safely. ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  }
}
