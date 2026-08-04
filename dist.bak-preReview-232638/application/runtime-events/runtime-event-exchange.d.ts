import type { RuntimeEvent, RuntimeEventFilter, RuntimeEventPublishInput } from '../../domain/events/events.js';
import type { NewMessage } from '../../domain/types.js';
import type { LiveAdmissionWorkItemEnqueueResult } from '../../domain/ports/live-turns.js';
import type { RuntimeEventRepository } from '../../domain/ports/repositories.js';
export interface RuntimeEventNotifier {
    notify(event: RuntimeEvent): Promise<void>;
    subscribe(listener: () => void, filter?: RuntimeEventFilter): () => void;
}
export interface RuntimeEventSubscription {
    next(options?: {
        timeoutMs?: number;
    }): Promise<RuntimeEvent[]>;
    close(): void;
}
export declare class RuntimeEventExchange {
    private readonly repository;
    private readonly notifier;
    constructor(repository: RuntimeEventRepository, notifier: RuntimeEventNotifier);
    publish(input: RuntimeEventPublishInput): Promise<RuntimeEvent>;
    publishWithLiveAdmissionMessage(input: RuntimeEventPublishInput, admission: {
        message: NewMessage;
        liveAdmission: {
            appId: string;
            agentId?: string | null;
            agentSessionId?: string | null;
            triggerDecision?: Record<string, unknown>;
            now?: string;
        };
    }): Promise<{
        event: RuntimeEvent;
        liveAdmissionResult: LiveAdmissionWorkItemEnqueueResult | undefined;
    }>;
    list(filter: RuntimeEventFilter): Promise<RuntimeEvent[]>;
    subscribe(filter: RuntimeEventFilter): RuntimeEventSubscription;
}
export declare class InMemoryRuntimeEventNotifier implements RuntimeEventNotifier {
    private readonly listeners;
    readonly notifiedEvents: RuntimeEvent[];
    notify(event: RuntimeEvent): Promise<void>;
    subscribe(listener: () => void, filter?: RuntimeEventFilter): () => void;
}
