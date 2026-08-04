import type { OutboundDelivery, OutboundDeliveryFinalAnswer, OutboundDeliveryId, OutboundDeliveryItem, OutboundDeliveryReceipt, OutboundDeliveryStatus } from '../../../../domain/outbound-delivery/outbound-delivery.js';
import * as pgSchema from '../schema/schema.js';
import type { CanonicalExecutor } from './canonical-graph-repository.postgres.js';
export type DeliveryRow = typeof pgSchema.outboundDeliveriesPostgres.$inferSelect;
export type ItemRow = typeof pgSchema.outboundDeliveryItemsPostgres.$inferSelect;
export type FinalAnswerRow = typeof pgSchema.outboundDeliveryFinalAnswersPostgres.$inferSelect;
export type ReceiptRow = typeof pgSchema.outboundDeliveryReceiptsPostgres.$inferSelect;
export declare function encodeJson(value: unknown): string;
export declare function isUniqueViolation(err: unknown): boolean;
export declare function mapDelivery(row: DeliveryRow): OutboundDelivery;
export declare function mapItem(row: ItemRow): OutboundDeliveryItem;
export declare function mapFinalAnswer(row: FinalAnswerRow): OutboundDeliveryFinalAnswer;
export declare function mapReceipt(row: ReceiptRow): OutboundDeliveryReceipt;
export declare function computeLeaseExpiry(now: string, leaseMs: number): string;
export declare function computeRetryBackoffMs(input: {
    attemptCount: number;
    baseDelayMs: number;
    maxDelayMs: number;
}): number;
export declare function timestampsRepresentSameInstant(left: string | null | undefined, right: string | null | undefined): boolean;
export declare function normalizeRetryTail(retryTail: {
    canonicalText: string;
    providerPayload?: unknown;
} | undefined): {
    canonicalText: string;
    providerPayload?: unknown;
} | undefined;
export declare function buildPartialDeliveryError(input: {
    error: string;
    deliveredParts?: number;
    totalParts?: number;
}): string;
export declare function deriveOutboundDeliveryStatus(input: {
    counts: {
        pending: number;
        claimed: number;
        sent: number;
        failed: number;
        partiallyDelivered: number;
    };
    earliestUnsentStatus?: OutboundDeliveryItem['status'] | string | null;
}): OutboundDeliveryStatus;
export declare function recomputeOutboundDeliveryStatus(tx: CanonicalExecutor, input: {
    deliveryId: OutboundDeliveryId;
    now?: string;
    fallbackNow: () => string;
    getDeliveryById: (db: CanonicalExecutor, id: OutboundDeliveryId) => Promise<OutboundDelivery | null>;
}): Promise<OutboundDelivery | null>;
