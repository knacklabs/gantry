import type { RuntimeEvent, RuntimeEventFilter } from './events.js';

export type RuntimeEventFilterable = Pick<
  RuntimeEvent,
  | 'eventId'
  | 'appId'
  | 'sessionId'
  | 'runId'
  | 'jobId'
  | 'triggerId'
  | 'conversationId'
  | 'threadId'
  | 'eventType'
>;

export function runtimeEventMatchesFilter(
  event: RuntimeEventFilterable,
  filter: RuntimeEventFilter,
): boolean {
  if (event.appId !== filter.appId) return false;
  if (
    filter.afterEventId !== undefined &&
    event.eventId <= filter.afterEventId
  ) {
    return false;
  }
  if (filter.sessionId !== undefined && event.sessionId !== filter.sessionId) {
    return false;
  }
  if (filter.runId !== undefined && event.runId !== filter.runId) {
    return false;
  }
  if (filter.jobId !== undefined && event.jobId !== filter.jobId) {
    return false;
  }
  if (filter.triggerId !== undefined && event.triggerId !== filter.triggerId) {
    return false;
  }
  if (
    filter.conversationId !== undefined &&
    event.conversationId !== filter.conversationId
  ) {
    return false;
  }
  if (filter.threadId !== undefined && event.threadId !== filter.threadId) {
    return false;
  }
  if (
    filter.eventTypes?.length &&
    !filter.eventTypes.includes(event.eventType)
  ) {
    return false;
  }
  return true;
}
