import type { OutboundMessage } from '../../domain/messages/messages.js';
import type { MessageRepository } from '../../domain/ports/repositories.js';

export class RecordOutboundMessageUseCase {
  constructor(private readonly messages: MessageRepository) {}

  async execute(input: { message: OutboundMessage }) {
    await this.messages.saveMessage(input.message);
    return { message: input.message };
  }
}
