import type { ClaimedOutboundDeliveryItem, OutboundDelivery } from '../../../../domain/outbound-delivery/outbound-delivery.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
export declare function claimDueOutboundDeliveryItems(db: CanonicalDb, input: {
    appId?: OutboundDelivery['appId'];
    profileId?: string;
    now: string;
    claimerId: string;
    leaseMs: number;
    limit: number;
}, createClaimToken: () => string): Promise<ClaimedOutboundDeliveryItem[]>;
