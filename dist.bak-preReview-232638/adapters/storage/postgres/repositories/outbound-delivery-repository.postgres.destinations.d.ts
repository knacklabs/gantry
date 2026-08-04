import type { OutboundDelivery, OutboundDeliveryResolvedDestination } from '../../../../domain/outbound-delivery/outbound-delivery.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
export declare function resolveOutboundDeliveryDestination(db: CanonicalDb, input: {
    appId: OutboundDelivery['appId'];
    conversationId: OutboundDelivery['conversationId'];
    threadId?: OutboundDelivery['threadId'];
}): Promise<OutboundDeliveryResolvedDestination | null>;
