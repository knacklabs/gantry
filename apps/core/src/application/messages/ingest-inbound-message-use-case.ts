import type { MessageRepository } from '../../domain/ports/repositories.js';
import type { InboundMessage } from '../../domain/messages/messages.js';
import type { InboundMessageQueuePort } from './inbound-message-ports.js';

export class IngestInboundMessageUseCase {
  constructor(
    private readonly deps: {
      messages: MessageRepository;
      queue?: InboundMessageQueuePort;
    },
  ) {}

  async execute(input: { message: InboundMessage }) {
    await this.deps.messages.saveMessage(input.message);
    await this.deps.queue?.enqueue(input.message);
    return { message: input.message };
  }
}
