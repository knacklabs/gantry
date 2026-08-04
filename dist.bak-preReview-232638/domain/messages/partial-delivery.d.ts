declare const PARTIAL_MESSAGE_DELIVERY_BRAND: unique symbol;
type PartialDeliveryRetryTail = {
    canonicalText: string;
    providerPayload?: unknown;
};
type BrandedPartialMessageDeliveryError = Error & {
    [PARTIAL_MESSAGE_DELIVERY_BRAND]: true;
    partialMessageDelivery: true;
    deliveredChunks: number;
    totalChunks: number;
    deliveredParts?: number;
    totalParts?: number;
    provider?: string;
    externalMessageIds?: string[];
    sentPrefix?: string;
    retryTail?: PartialDeliveryRetryTail;
};
type PartialMessageDeliveryMetadata = {
    deliveredParts?: number;
    totalParts?: number;
    provider?: string;
    externalMessageIds?: string[];
    sentPrefix?: string;
    retryTail?: PartialDeliveryRetryTail;
};
export declare class PartialMessageDeliveryError extends Error implements BrandedPartialMessageDeliveryError {
    readonly [PARTIAL_MESSAGE_DELIVERY_BRAND] = true;
    readonly partialMessageDelivery = true;
    readonly deliveredChunks: number;
    readonly totalChunks: number;
    readonly cause?: unknown;
    constructor(args: {
        cause: unknown;
        deliveredChunks: number;
        name: string;
        message: string;
        totalChunks: number;
    });
}
export declare function isPartialMessageDeliveryError(err: unknown): err is BrandedPartialMessageDeliveryError;
export declare function getPartialMessageDeliveryMetadata(err: unknown): PartialMessageDeliveryMetadata;
export {};
