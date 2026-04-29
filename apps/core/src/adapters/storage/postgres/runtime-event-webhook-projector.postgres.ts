import type { RuntimeEventProjection } from '../../../application/runtime-events/runtime-event-exchange.js';
import type { RuntimeEvent } from '../../../domain/events/events.js';
import type { PostgresControlPlaneRepository } from './schema/control-plane-repo.postgres.js';

export class PostgresRuntimeEventWebhookProjector implements RuntimeEventProjection {
  constructor(private readonly control: PostgresControlPlaneRepository) {}

  async project(event: RuntimeEvent): Promise<void> {
    if (
      event.webhookId &&
      (event.responseMode === 'webhook' || event.responseMode === 'both')
    ) {
      const webhook = await this.control.getWebhookById(
        event.webhookId,
        event.appId,
      );
      if (!webhook) return;
      await this.control.enqueueWebhookDelivery(event.eventId, event.webhookId);
    }
  }
}
