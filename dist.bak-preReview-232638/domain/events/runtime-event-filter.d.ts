import type { RuntimeEvent, RuntimeEventFilter } from './events.js';
export type RuntimeEventFilterable = Pick<RuntimeEvent, 'eventId' | 'appId' | 'sessionId' | 'runId' | 'jobId' | 'triggerId' | 'conversationId' | 'threadId' | 'eventType'>;
export declare function runtimeEventMatchesFilter(event: RuntimeEventFilterable, filter: RuntimeEventFilter): boolean;
