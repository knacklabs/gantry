import type { EventBusPublisherPort } from '../../../../domain/events/event-bus.js';
import type { NewMessage } from '../../../../domain/repositories/domain-types.js';
import type { RuntimeEvent, RuntimeEventFilter, RuntimeEventPublishInput, UsageAggregate, UsageQuery } from '../../../../domain/events/events.js';
import type { LiveAdmissionWorkItemEnqueueResult } from '../../../../domain/ports/live-turns.js';
import type { RuntimeEventRepository } from '../../../../domain/ports/repositories.js';
import { type CanonicalDb, type CanonicalExecutor } from './canonical-graph-repository.postgres.js';
import { type MessageLiveAdmissionInput } from './canonical-message-repository.postgres.js';
export declare class PostgresRuntimeEventRepository implements RuntimeEventRepository {
    private readonly db;
    private readonly eventBus;
    private readonly maxLiveAdmissionBacklog;
    constructor(db: CanonicalDb, eventBus?: EventBusPublisherPort<CanonicalExecutor>, maxLiveAdmissionBacklog?: number);
    appendRuntimeEvent(input: RuntimeEventPublishInput): Promise<RuntimeEvent>;
    appendRuntimeEventAndStoreLiveAdmission(input: RuntimeEventPublishInput, admission: {
        message: NewMessage;
        liveAdmission: MessageLiveAdmissionInput;
    }): Promise<{
        event: RuntimeEvent;
        liveAdmissionResult: LiveAdmissionWorkItemEnqueueResult | undefined;
    }>;
    private insertRuntimeEvent;
    private enqueueWebhookDeliveryIfNeeded;
    listRuntimeEvents(filter: RuntimeEventFilter): Promise<RuntimeEvent[]>;
    queryUsage(input: UsageQuery): Promise<UsageAggregate[]>;
    private eventFromRow;
}
