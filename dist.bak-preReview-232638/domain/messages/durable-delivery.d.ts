declare const AMBIGUOUS_DURABLE_DELIVERY_BRAND: unique symbol;
type BrandedAmbiguousDurableDeliveryError = Error & {
    [AMBIGUOUS_DURABLE_DELIVERY_BRAND]: true;
    ambiguousDurableDelivery: true;
    provider: string;
    conversationJid: string;
    externalMessageId?: string;
    externalMessageIds?: string[];
};
export declare class AmbiguousDurableDeliveryError extends Error implements BrandedAmbiguousDurableDeliveryError {
    readonly [AMBIGUOUS_DURABLE_DELIVERY_BRAND] = true;
    readonly ambiguousDurableDelivery = true;
    readonly provider: string;
    readonly conversationJid: string;
    readonly externalMessageId?: string;
    readonly externalMessageIds?: string[];
    readonly cause?: unknown;
    constructor(input: {
        provider: string;
        conversationJid: string;
        message?: string;
        cause: unknown;
        externalMessageId?: string;
        externalMessageIds?: string[];
    });
}
export declare function isAmbiguousDurableDeliveryError(err: unknown): err is BrandedAmbiguousDurableDeliveryError;
export {};
