import { getRuntimeControlRepository } from '../../adapters/storage/postgres/runtime-store.js';
import type { RuntimeEvent } from '../../domain/events/events.js';
type WebhookDeliveryEnvelopeEvent = Pick<RuntimeEvent, 'eventId' | 'eventType' | 'agentId' | 'sessionId' | 'jobId' | 'runId' | 'triggerId' | 'conversationId' | 'threadId' | 'correlationId' | 'createdAt' | 'payload'>;
export declare function buildWebhookDeliveryEnvelope(event: WebhookDeliveryEnvelopeEvent): Record<string, unknown>;
export declare function deliverWebhookDelivery(delivery: Awaited<ReturnType<ReturnType<typeof getRuntimeControlRepository>['claimDueWebhookDeliveries']>>[number]): Promise<void>;
export declare function flushWebhookDeliveries(): Promise<void>;
export declare function logWebhookFlushFailure(error: unknown): void;
export {};
