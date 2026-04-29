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

  markTurnBoundary(): number {
    if (this.closed) return 0;
    this.atTurnBoundary = true;
    if (this.bufferedMessages.length === 0) return 0;
    const messages = this.bufferedMessages.splice(0);
    this.deliverBatch(messages);
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
