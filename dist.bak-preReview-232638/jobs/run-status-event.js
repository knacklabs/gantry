import { RUNTIME_EVENT_TYPES } from '../domain/events/runtime-event-types.js';
export function runtimeEventTypeForRunStatus(status) {
    switch (status) {
        case 'paused':
            return RUNTIME_EVENT_TYPES.RUN_PAUSED;
        case 'completed':
            return RUNTIME_EVENT_TYPES.RUN_COMPLETED;
        case 'failed':
            return RUNTIME_EVENT_TYPES.RUN_FAILED;
        case 'timeout':
            return RUNTIME_EVENT_TYPES.RUN_TIMEOUT;
        case 'dead_lettered':
            return RUNTIME_EVENT_TYPES.RUN_DEAD_LETTERED;
    }
}
