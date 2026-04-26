import type { OutboundMessage } from '../../domain/messages/messages.js';
import type { MessageRepository } from '../../domain/ports/repositories.js';

export interface OutboundMessageDeliveryPort {
  send(message: OutboundMessage): Promise<void>;
}

export class SendOutboundMessageUseCase {
  constructor(
    private readonly deps: {
      messages: MessageRepository;
      delivery: OutboundMessageDeliveryPort;
    },
  ) {}

  async execute(input: { message: OutboundMessage }) {
    await this.deps.delivery.send(input.message);
    await this.deps.messages.saveMessage(input.message);
    return { message: input.message };
  }
}
