/**
 * Buffers user steering while Claude may be between assistant tool_use and
 * matching tool_result messages. Callers mark a turn boundary only after the
 * SDK has emitted a completed result/boundary; buffered steering is then
 * delivered as one synchronous batch before the next assistant cycle starts.
 */
export class SteeringDeliveryGate {
    deliver;
    atTurnBoundary = false;
    closed = false;
    bufferedMessages = [];
    constructor(deliver) {
        this.deliver = deliver;
    }
    accept(text) {
        if (this.closed)
            return 'closed';
        if (this.atTurnBoundary) {
            this.deliverBatch([text]);
            return 'delivered';
        }
        this.bufferedMessages.push(text);
        return 'buffered';
    }
    pendingCount() {
        return this.bufferedMessages.length;
    }
    markTurnBoundary() {
        if (this.closed)
            return 0;
        this.atTurnBoundary = true;
        if (this.bufferedMessages.length === 0)
            return 0;
        const messages = this.bufferedMessages.splice(0);
        for (const text of messages) {
            this.deliver(text);
        }
        this.atTurnBoundary = false;
        return messages.length;
    }
    close() {
        this.closed = true;
        this.bufferedMessages.length = 0;
        this.atTurnBoundary = false;
    }
    deliverBatch(messages) {
        this.atTurnBoundary = false;
        for (const text of messages) {
            this.deliver(text);
        }
    }
}
