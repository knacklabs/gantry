import { ApplicationError } from '../common/application-error.js';
export function requireJobControl(deps) {
    if (!deps.control) {
        throw new ApplicationError('UNAVAILABLE', 'Job control repository unavailable');
    }
    return deps.control;
}
export function requireRuntimeEvents(deps) {
    if (!deps.runtimeEvents) {
        throw new ApplicationError('UNAVAILABLE', 'Runtime event publisher unavailable');
    }
    return deps.runtimeEvents;
}
export function requireTriggerQueue(deps) {
    if (!deps.triggerQueue) {
        throw new ApplicationError('UNAVAILABLE', 'Scheduler trigger queue unavailable');
    }
    return deps.triggerQueue;
}
