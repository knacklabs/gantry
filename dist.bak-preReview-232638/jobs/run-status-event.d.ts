import type { RuntimeEventType } from '../domain/events/runtime-event-types.js';
export declare function runtimeEventTypeForRunStatus(status: 'paused' | 'completed' | 'failed' | 'timeout' | 'dead_lettered'): RuntimeEventType;
