import type { Pool } from 'pg';
import type { RuntimeEventNotifier } from '../../../application/runtime-events/runtime-event-exchange.js';
import type { RuntimeEvent, RuntimeEventFilter } from '../../../domain/events/events.js';
export interface RuntimeEventWakeup {
    eventId: RuntimeEvent['eventId'];
    appId: RuntimeEvent['appId'];
    complete: boolean;
    sessionId?: RuntimeEvent['sessionId'];
    runId?: RuntimeEvent['runId'];
    jobId?: RuntimeEvent['jobId'];
    triggerId?: string;
    conversationId?: RuntimeEvent['conversationId'];
    threadId?: RuntimeEvent['threadId'];
    eventType: RuntimeEvent['eventType'];
}
export declare function parseRuntimeEventWakeup(payload: string | undefined): RuntimeEventWakeup | null;
export declare class PostgresRuntimeEventNotifier implements RuntimeEventNotifier {
    private readonly pool;
    private readonly listeners;
    private clientPromise;
    private client;
    private reconnectTimer;
    private closed;
    constructor(pool: Pool);
    notify(event: RuntimeEvent): Promise<void>;
    subscribe(listener: () => void, filter?: RuntimeEventFilter): () => void;
    close(): Promise<void>;
    private ensureListening;
    private handleClientFailure;
    private releaseClient;
    private wakeListeners;
    private scheduleReconnect;
}
