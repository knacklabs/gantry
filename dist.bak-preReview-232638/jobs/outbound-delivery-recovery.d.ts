import type { OutboundDeliveryService } from '../application/outbound-delivery/outbound-delivery-service.js';
import type { ClaimedOutboundDeliveryItem, OutboundDelivery } from '../domain/outbound-delivery/outbound-delivery.js';
export interface OutboundDeliveryPartialRetryTail {
    canonicalText: string;
    providerPayload?: unknown;
}
export type OutboundDeliveryDispatchResult = {
    status: 'sent';
    providerMessageId?: string;
    providerPayload?: unknown;
} | {
    status: 'failed';
    error?: string;
} | {
    status: 'partially_delivered';
    error?: string;
    deliveredParts?: number;
    totalParts?: number;
    retryTail?: OutboundDeliveryPartialRetryTail;
};
export interface OutboundDeliveryRecoveryResult {
    batches: number;
    claimed: number;
    sent: number;
    failed: number;
    stoppedReason: 'drained' | 'max_batches';
}
export interface OutboundDeliveryRecoveryInput {
    service: OutboundDeliveryService;
    appId?: OutboundDelivery['appId'];
    claimerId: string;
    dispatch: (claimed: ClaimedOutboundDeliveryItem) => Promise<OutboundDeliveryDispatchResult>;
    batchLimit?: number;
    leaseMs?: number;
    maxBatches?: number;
    now?: () => string;
    receiptIdempotencyKeyForItem?: (claimed: ClaimedOutboundDeliveryItem) => string;
    warn?: (meta: Record<string, unknown>, message: string) => void;
}
export interface OutboundDeliveryRecoveryLoopController {
    isRunning: () => boolean;
    stop: () => Promise<void>;
}
export declare function runBoundedOutboundDeliveryRecovery(input: OutboundDeliveryRecoveryInput): Promise<OutboundDeliveryRecoveryResult>;
export declare function startOutboundDeliveryRecoveryLoop(input: OutboundDeliveryRecoveryInput & {
    intervalMs?: number;
}): OutboundDeliveryRecoveryLoopController;
export declare function stopOutboundDeliveryRecoveryLoop(): Promise<void>;
