import type { EventBusEnvelope, EventBusPublisherPort, EventBusPublishInput } from '../../../../domain/events/event-bus.js';
import type { CanonicalDb, CanonicalExecutor } from './canonical-graph-repository.postgres.js';
export interface WebhookSubscriptionFilter {
    eventTypes: readonly string[] | null;
    agentId: string | null;
    sessionId: string | null;
    jobId: string | null;
}
export interface WebhookRuntimeEventSubject {
    eventType: string;
    agentId: string | null;
    sessionId: string | null;
    jobId: string | null;
}
export declare function webhookSubscriptionMatchesRuntimeEvent(subscription: WebhookSubscriptionFilter, event: WebhookRuntimeEventSubject): boolean;
export declare class PostgresEventBusPublisher implements EventBusPublisherPort<CanonicalExecutor> {
    private readonly db;
    private readonly createId;
    constructor(db: CanonicalDb, createId?: () => string);
    publish(input: EventBusPublishInput, executor?: CanonicalExecutor): Promise<EventBusEnvelope>;
}
export interface EventBusOutboxConsumeResult {
    claimed: number;
    deliveriesEnqueued: number;
    settled: number;
}
export declare function settleEventBusOutboxRows(executor: CanonicalExecutor, ids: readonly string[]): Promise<number>;
export declare class PostgresEventBusOutboxConsumer {
    private readonly db;
    private readonly createId;
    constructor(db: CanonicalDb, createId?: () => string);
    consume(limit?: number): Promise<EventBusOutboxConsumeResult>;
}
