/**
 * Buffers user steering while Claude may be between assistant tool_use and
 * matching tool_result messages. Callers mark a turn boundary only after the
 * SDK has emitted a completed result/boundary; buffered steering is then
 * delivered as one synchronous batch before the next assistant cycle starts.
 */
export declare class SteeringDeliveryGate {
    private readonly deliver;
    private atTurnBoundary;
    private closed;
    private readonly bufferedMessages;
    constructor(deliver: (text: string) => void);
    accept(text: string): 'delivered' | 'buffered' | 'closed';
    pendingCount(): number;
    markTurnBoundary(): number;
    close(): void;
    private deliverBatch;
}
