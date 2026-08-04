import { type ClaimedOutboundDeliveryItem, type OutboundDelivery, type OutboundDeliveryFinalAnswer, type OutboundDeliveryId, type OutboundDeliveryItem, type OutboundDeliveryItemId, type OutboundDeliveryReceipt, type OutboundDeliveryReceiptId, type OutboundDeliveryResolvedDestination } from '../../../../domain/outbound-delivery/outbound-delivery.js';
import type { OutboundDeliveryRepository } from '../../../../domain/ports/repositories.js';
import { type CanonicalDb } from './canonical-graph-repository.postgres.js';
export declare class PostgresOutboundDeliveryRepository implements OutboundDeliveryRepository {
    private readonly db;
    private readonly deps;
    constructor(db: CanonicalDb, deps?: {
        now?: () => string;
        createClaimToken?: () => string;
    });
    enqueueDelivery(input: {
        delivery: OutboundDelivery;
        finalAnswer: OutboundDeliveryFinalAnswer;
        items: OutboundDeliveryItem[];
    }): Promise<{
        created: boolean;
        delivery: OutboundDelivery;
    }>;
    getDelivery(id: OutboundDeliveryId): Promise<OutboundDelivery | null>;
    claimDueDeliveryItems(input: {
        appId?: OutboundDelivery['appId'];
        profileId?: string;
        now: string;
        claimerId: string;
        leaseMs: number;
        limit: number;
    }): Promise<ClaimedOutboundDeliveryItem[]>;
    resolveDeliveryDestination(input: {
        appId: OutboundDelivery['appId'];
        conversationId: OutboundDelivery['conversationId'];
        threadId?: OutboundDelivery['threadId'];
    }): Promise<OutboundDeliveryResolvedDestination | null>;
    markDeliveryItemSent(input: {
        deliveryId: OutboundDeliveryId;
        itemId: OutboundDeliveryItemId;
        claimToken: string;
        receipt: OutboundDeliveryReceipt;
    }): Promise<{
        applied: boolean;
        delivery: OutboundDelivery | null;
    }>;
    markDeliveryItemFailed(input: {
        deliveryId: OutboundDeliveryId;
        itemId: OutboundDeliveryItemId;
        claimToken: string;
        error: string;
        failedAt: string;
        maxAttempts: number;
        retryBaseDelayMs: number;
        retryMaxDelayMs: number;
    }): Promise<{
        applied: boolean;
        delivery: OutboundDelivery | null;
    }>;
    markDeliveryItemPartiallyDelivered(input: {
        deliveryId: OutboundDeliveryId;
        itemId: OutboundDeliveryItemId;
        claimToken: string;
        error: string;
        partialAt: string;
        deliveredParts?: number;
        totalParts?: number;
        retryTail?: {
            canonicalText: string;
            providerPayload?: unknown;
        };
    }): Promise<{
        applied: boolean;
        delivery: OutboundDelivery | null;
    }>;
    listReceiptsForItem(itemId: OutboundDeliveryItemId): Promise<OutboundDeliveryReceipt[]>;
    getReceipt(id: OutboundDeliveryReceiptId): Promise<OutboundDeliveryReceipt | null>;
    private now;
    private createClaimToken;
    private findByAppAndIdempotency;
    private assertSameIdempotencyFingerprint;
    private ensureCanonicalProviderThread;
    private getDeliveryById;
    private assertOwnedConversationThread;
    private getReceiptByItemAndIdempotency;
    private isExactReceiptReplay;
    private recomputeDeliveryStatus;
}
export declare function canonicalProviderThreadForDelivery(input: {
    appId: OutboundDelivery['appId'];
    conversationId: OutboundDelivery['conversationId'];
    threadId?: OutboundDelivery['threadId'];
}): {
    id: string;
    appId: OutboundDelivery['appId'];
    conversationId: OutboundDelivery['conversationId'];
    externalRefJson: string;
} | null;
