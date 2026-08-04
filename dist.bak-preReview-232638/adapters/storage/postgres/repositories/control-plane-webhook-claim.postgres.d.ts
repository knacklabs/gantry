import type { ClaimedWebhookDeliveryRecord } from '../schema/control-plane-records.postgres.js';
import type { CanonicalDb } from './canonical-graph-repository.postgres.js';
export declare function claimDueWebhookDeliveriesWithDrizzleLock(db: CanonicalDb, limit?: number): Promise<ClaimedWebhookDeliveryRecord[]>;
