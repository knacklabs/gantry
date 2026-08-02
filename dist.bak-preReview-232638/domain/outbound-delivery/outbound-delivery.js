export class OutboundDeliveryIdempotencyConflictError extends Error {
    constructor(message = 'Outbound delivery idempotency key conflict') {
        super(message);
        this.name = 'OutboundDeliveryIdempotencyConflictError';
    }
}
