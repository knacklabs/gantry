/**
 * Buffers user steering while Claude may be between assistant tool_use and
 * matching tool_result messages. Callers mark a turn boundary only after the
 * SDK has emitted a completed result/boundary; buffered steering is then
 * delivered as one synchronous batch before the next assistant cycle starts.
 */
export class SteeringDeliveryGate {
  private atTurnBoundary = false;
  private closed = false;
  private readonly bufferedMessages: string[] = [];

  constructor(private readonly deliver: (text: string) => void) {}

  accept(text: string): 'delivered' | 'buffered' | 'closed' {
    if (this.closed) return 'closed';
    if (this.atTurnBoundary) {
      this.deliverBatch([text]);
      return 'delivered';
    }
    this.bufferedMessages.push(text);
    return 'buffered';
  }

  pendingCount(): number {
    return this.bufferedMessages.length;
  }

  markTurnBoundary(): number {
    if (this.closed) return 0;
    this.atTurnBoundary = true;
    if (this.bufferedMessages.length === 0) return 0;
    const messages = this.bufferedMessages.splice(0);
    for (const text of messages) {
      this.deliver(text);
    }
    this.atTurnBoundary = false;
    return messages.length;
  }

  close(): void {
    this.closed = true;
    this.bufferedMessages.length = 0;
    this.atTurnBoundary = false;
  }

  private deliverBatch(messages: string[]): void {
    this.atTurnBoundary = false;
    for (const text of messages) {
      this.deliver(text);
    }
  }
}
