import type { OutboundDeliveryProfileRegistry } from '../../domain/outbound-delivery/planner.js';
import type { OutboundDelivery, OutboundDeliveryId, OutboundDeliveryItem, OutboundDeliveryReceipt, OutboundDeliveryResolvedDestination } from '../../domain/outbound-delivery/outbound-delivery.js';
import type { OutboundDeliveryRepository } from '../../domain/ports/repositories.js';
export declare class OutboundDeliveryService {
    private readonly deps;
    constructor(deps: {
        repository: OutboundDeliveryRepository;
        profiles: OutboundDeliveryProfileRegistry;
        now: () => string;
        createId: () => string;
        hashSha256Hex: (value: string) => string;
    });
    enqueue(input: {
        appId: OutboundDelivery['appId'];
        conversationId: OutboundDelivery['conversationId'];
        threadId?: OutboundDelivery['threadId'];
        agentId?: OutboundDelivery['agentId'];
        runId?: OutboundDelivery['runId'];
        profileId: string;
        idempotencyKey: string;
        text: string;
        metadata?: Record<string, unknown>;
        maxSegments?: number;
        maxSegmentChars?: number;
        maxFinalTextChars?: number;
        deliveryId?: OutboundDeliveryId;
        initialClaim?: {
            claimToken?: string;
            claimExpiresAt?: string;
        };
    }): Promise<{
        created: boolean;
        delivery: OutboundDelivery;
        claimedItem?: {
            itemId: OutboundDeliveryItem['id'];
            claimToken: string;
        };
        claimedItems?: Array<{
            itemId: OutboundDeliveryItem['id'];
            claimToken: string;
        }>;
    }>;
    claimPending(input: {
        appId: OutboundDelivery['appId'];
        profileId?: string;
        claimerId: string;
        limit?: number;
        leaseMs?: number;
        now?: string;
    }): Promise<import("../../domain/outbound-delivery/outbound-delivery.js").ClaimedOutboundDeliveryItem[]>;
    claimPendingAcrossApps(input: {
        profileId?: string;
        claimerId: string;
        limit?: number;
        leaseMs?: number;
        now?: string;
    }): Promise<import("../../domain/outbound-delivery/outbound-delivery.js").ClaimedOutboundDeliveryItem[]>;
    resolveDestination(input: {
        appId: OutboundDelivery['appId'];
        conversationId: OutboundDelivery['conversationId'];
        threadId?: OutboundDelivery['threadId'];
    }): Promise<OutboundDeliveryResolvedDestination | null>;
    settleSent(input: {
        deliveryId: OutboundDelivery['id'];
        itemId: OutboundDeliveryItem['id'];
        claimToken: string;
        receiptIdempotencyKey: string;
        providerMessageId?: string;
        providerPayload?: unknown;
        sentAt?: string;
        receiptId?: OutboundDeliveryReceipt['id'];
    }): Promise<{
        applied: boolean;
        delivery: OutboundDelivery | null;
    }>;
    settleFailed(input: {
        deliveryId: OutboundDelivery['id'];
        itemId: OutboundDeliveryItem['id'];
        claimToken: string;
        error: string;
        failedAt?: string;
        maxAttempts?: number;
        retryBaseDelayMs?: number;
        retryMaxDelayMs?: number;
    }): Promise<{
        applied: boolean;
        delivery: OutboundDelivery | null;
    }>;
    settlePartiallyDelivered(input: {
        deliveryId: OutboundDelivery['id'];
        itemId: OutboundDeliveryItem['id'];
        claimToken: string;
        error: string;
        partialAt?: string;
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
}
