import type { OutboundDeliveryService } from '../../application/outbound-delivery/outbound-delivery-service.js';
import type { ClaimedOutboundDeliveryItem } from '../../domain/outbound-delivery/outbound-delivery.js';
import { nowIso } from '../../shared/time/datetime.js';
import { dispatchPreparedPermissionCard } from '../../jobs/permission-card-delivery.js';
export { setupPermissionCardProfile } from '../../jobs/permission-card-delivery.js';
import type {
  ChannelWiring,
  RecoveryDispatchPermit,
} from './channel-wiring-types.js';

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
