import type { Message } from '../../domain/messages/messages.js';

export interface InboundMessageQueuePort {
  enqueue(message: Message): Promise<void>;
}
