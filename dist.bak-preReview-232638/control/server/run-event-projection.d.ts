import type { RuntimeEvent } from '../../domain/events/events.js';
export interface PublicRunEvent {
    id: string;
    appId: string;
    runId: string;
    type: 'queued' | 'started' | 'diagnostic' | 'model_event' | 'tool_request' | 'permission_decision' | 'output_chunk' | 'completed' | 'failed' | 'canceled';
    payload: unknown;
    createdAt: string;
    metadata: {
        runtimeEventType: RuntimeEvent['eventType'];
    };
}
export declare function projectRuntimeEventToRunEvent(event: RuntimeEvent, fallbackRunId?: string): PublicRunEvent;
