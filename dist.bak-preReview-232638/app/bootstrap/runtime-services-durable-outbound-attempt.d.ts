import type { OutboundDeliveryService } from '../../application/outbound-delivery/outbound-delivery-service.js';
import type { DurableOutboundAttempt } from './channel-wiring-types.js';
interface ClaimedLiveSendItem {
    itemId: string;
    claimToken: string;
}
export declare function createDurableOutboundAttempt(input: {
    outboundDeliveryService: OutboundDeliveryService;
    deliveryId: string;
    claimedItems: ClaimedLiveSendItem[];
    sourceMessageId: string;
}): DurableOutboundAttempt;
export {};
