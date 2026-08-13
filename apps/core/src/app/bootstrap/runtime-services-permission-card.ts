import type { OutboundDeliveryService } from '../../application/outbound-delivery/outbound-delivery-service.js';
import type { OutboundDeliveryRepository } from '../../domain/ports/repositories.js';
import type { ClaimedOutboundDeliveryItem } from '../../domain/outbound-delivery/outbound-delivery.js';
import { nowIso } from '../../shared/time/datetime.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { dispatchPreparedPermissionCard } from '../../jobs/permission-card-delivery.js';
import { startSetupPromptReconciliationLoop } from '../../jobs/outbound-delivery-recovery.js';
export { setupPermissionCardProfile } from '../../jobs/permission-card-delivery.js';
import type {
  ChannelWiring,
  RecoveryDispatchPermit,
} from './channel-wiring-types.js';

export const PERMISSION_CARD_DISPATCH_ACTIVE = true;

// Separate supervised loop: reconciliation must never gate delivery
// claims (its lock waits and failures stay its own).
export function startRuntimePermissionCardReconciliation(
  repository: OutboundDeliveryRepository,
): void {
  if (!PERMISSION_CARD_DISPATCH_ACTIVE) return;
  startSetupPromptReconciliationLoop({
    run: () => reconcileRuntimePermissionCards(repository),
    intervalMs: 5_000,
    warn: (meta, message) => logger.warn(meta, message),
  });
}

export async function reconcileRuntimePermissionCards(
  repository: OutboundDeliveryRepository,
): Promise<void> {
  await (
    repository as OutboundDeliveryRepository & {
      reconcileSetupPermissionPrompts?: (input: {
        now: string;
      }) => Promise<unknown>;
    }
  ).reconcileSetupPermissionPrompts?.({ now: nowIso() });
}

export function dispatchRuntimePermissionCard(input: {
  service: OutboundDeliveryService;
  claimed: ClaimedOutboundDeliveryItem;
  channelWiring: ChannelWiring;
  destinationJid: string;
  destinationThreadId?: string;
  providerAccountId: string;
  permit: RecoveryDispatchPermit;
}) {
  return dispatchPreparedPermissionCard({
    service: input.service,
    claimed: input.claimed,
    now: () => nowIso(),
    prepare: (permissionCardView) =>
      input.channelWiring.prepareProviderPermissionCardSend(
        input.destinationJid,
        input.claimed.item.canonicalText,
        {
          permit: input.permit,
          messageOptions: {
            providerAccountId: input.providerAccountId,
            ...(input.destinationThreadId
              ? { threadId: input.destinationThreadId }
              : {}),
            permissionCardView,
          },
        },
      ),
  });
}
