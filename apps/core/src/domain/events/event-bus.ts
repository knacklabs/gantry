import type { AppId } from '../app/app.js';
import type { RuntimeEventId } from './events.js';
import type { BrandedId } from '../../shared/ids/branded-id.js';
import type { IsoTimestamp } from '../../shared/time/primitives.js';

export type EventBusOutboxId = BrandedId<'EventBusOutboxId'>;

export interface EventBusPublishInput {
  id?: EventBusOutboxId;
  type: string;
  version: number;
  source: string;
  appId: AppId;
  runtimeEventId?: RuntimeEventId;
  correlationId?: string | null;
  payload: unknown;
  occurredAt: IsoTimestamp;
}

export interface EventBusEnvelope extends EventBusPublishInput {
  id: EventBusOutboxId;
}

export interface EventBusPublisherPort<TContext = unknown> {
  publish(
    input: EventBusPublishInput,
    context?: TContext,
  ): Promise<EventBusEnvelope>;
}
