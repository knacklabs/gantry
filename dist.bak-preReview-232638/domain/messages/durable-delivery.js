const AMBIGUOUS_DURABLE_DELIVERY_BRAND = Symbol('gantry.ambiguousDurableDelivery');
export class AmbiguousDurableDeliveryError extends Error {
    [AMBIGUOUS_DURABLE_DELIVERY_BRAND] = true;
    ambiguousDurableDelivery = true;
    provider;
    conversationJid;
    externalMessageId;
    externalMessageIds;
    cause;
    constructor(input) {
        super(input.message ??
            'Provider send succeeded but durable sent-status persistence failed. Delivery visibility is ambiguous and cannot be blindly retried.');
        this.name = 'AmbiguousDurableDeliveryError';
        this.provider = input.provider;
        this.conversationJid = input.conversationJid;
        this.cause = input.cause;
        this.externalMessageId = input.externalMessageId;
        this.externalMessageIds = input.externalMessageIds;
    }
}
export function isAmbiguousDurableDeliveryError(err) {
    return (typeof err === 'object' &&
        err !== null &&
        err[AMBIGUOUS_DURABLE_DELIVERY_BRAND] === true &&
        err.ambiguousDurableDelivery ===
            true);
}
